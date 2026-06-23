/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelInfo, Options, Query, SDKControlInitializeResponse, SDKMessage, SDKUserMessage, WarmQuery } from '@anthropic-ai/claude-agent-sdk';
import { spawn, type ChildProcess } from 'child_process';
import type { Readable } from 'stream';
import { DeferredPromise } from '../../../../base/common/async.js';
import { ILogService } from '../../../log/common/log.js';

/**
 * Transport that drives the user's installed `claude` CLI binary in headless
 * stream-json mode, exposed through the same {@link WarmQuery} / {@link Query}
 * surface the SDK transport returns. This lets the agent host's Claude provider
 * reuse the entire SDK pipeline + event mapper (`claudeMapSessionEvents.ts`)
 * unchanged — the CLI's `--output-format stream-json` is structurally identical
 * to the SDK's `SDKMessage` stream.
 *
 * Why this exists: the SDK, running as an Electron utility process, cannot
 * silently read the macOS keychain, so it reports "Not logged in" unless
 * `CLAUDE_CODE_OAUTH_TOKEN` is force-forwarded into its environment. The
 * standalone `claude` binary CAN read the keychain. Spawning it directly
 * (inheriting the agent host's resolved shell environment) authenticates the
 * GUI from the user's existing `claude login` with no token env var — the same
 * way terminal mode works.
 *
 * MVP scope: only the {@link Query} members the `ClaudeSdkPipeline` actually
 * calls are backed by real behavior. The `initialize` control handshake IS
 * spoken (so {@link Query.supportedModels} returns the running instance's real
 * model list); the remaining mid-session
 * control requests (`setModel`, `setPermissionMode`, flag settings, plugin
 * reload, customization snapshots) are not reimplemented — those degrade to
 * no-ops / empty results. Model / permission mode are applied via spawn flags,
 * so they take effect on the next (re)materialize rather than mid-session.
 */

/**
 * Newline-delimited reader over a child process stdout stream. Attaches its
 * `data` listener eagerly (in the constructor) so lines emitted before the
 * consumer starts iterating are buffered, not dropped.
 */
class LineReader {
	private _buffer = '';
	private readonly _lines: string[] = [];
	private _waiter: (() => void) | undefined;
	private _ended = false;

	constructor(stream: Readable) {
		stream.setEncoding('utf8');
		stream.on('data', (chunk: string) => {
			this._buffer += chunk;
			let idx: number;
			while ((idx = this._buffer.indexOf('\n')) >= 0) {
				this._lines.push(this._buffer.slice(0, idx));
				this._buffer = this._buffer.slice(idx + 1);
			}
			this._wake();
		});
		const finish = () => {
			if (this._buffer.length > 0) {
				this._lines.push(this._buffer);
				this._buffer = '';
			}
			this._ended = true;
			this._wake();
		};
		stream.on('end', finish);
		stream.on('close', finish);
	}

	private _wake(): void {
		const waiter = this._waiter;
		this._waiter = undefined;
		waiter?.();
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<string> {
		while (true) {
			while (this._lines.length > 0) {
				yield this._lines.shift()!;
			}
			if (this._ended) {
				return;
			}
			await new Promise<void>(resolve => { this._waiter = resolve; });
		}
	}
}

/**
 * Monotonic counter backing the `request_id` of every control request this
 * transport writes. A plain counter (rather than `Math.random()`) keeps ids
 * deterministic and collision-free within a process — they only need to be
 * unique among this transport's in-flight requests.
 */
let controlRequestSeq = 0;

/**
 * The `control_response` frame the CLI writes to stdout in reply to a
 * `control_request`. Structurally mirrors the SDK's own control protocol:
 * the outer `response` carries the correlation `request_id` and a `success` /
 * `error` `subtype`; on success its inner `response` is the request-specific
 * payload (for `initialize`, a {@link SDKControlInitializeResponse} carrying
 * the account's available `models`).
 */
interface ICliControlResponseFrame {
	readonly type: 'control_response';
	readonly response: {
		readonly subtype: 'success' | 'error';
		readonly request_id: string;
		readonly response?: SDKControlInitializeResponse;
		readonly error?: string;
	};
}

/**
 * Build the CLI args for one headless stream-json session from the SDK
 * {@link Options} the materialize path already computed.
 */
function buildCliArgs(options: Options): string[] {
	const args = [
		'-p',
		'--output-format', 'stream-json',
		'--input-format', 'stream-json',
		'--verbose',
		'--include-partial-messages',
	];
	if (options.model) {
		args.push('--model', options.model);
	}
	if (options.permissionMode) {
		args.push('--permission-mode', options.permissionMode);
	}
	// `resume` and `sessionId` are mutually exclusive in the SDK options: a
	// fresh session pins its id via `--session-id`, a resume re-attaches via
	// `--resume`. Mirror that so the CLI writes its transcript under the id the
	// agent host already tracks (so SDK-backed `listSessions` / resume still
	// line up).
	if (options.resume) {
		args.push('--resume', options.resume);
	} else if (options.sessionId) {
		args.push('--session-id', options.sessionId);
	}
	return args;
}

/**
 * Build the spawn environment for the `claude` child. Inherits the agent host's
 * (already shell-resolved) environment so the binary is found on PATH and can
 * read the keychain, but strips the Electron / VS Code variables that would
 * confuse a plain Node CLI. Crucially does NOT inject `CLAUDE_CODE_OAUTH_TOKEN`
 * and does NOT set `ANTHROPIC_BASE_URL` — the binary authenticates itself.
 */
function buildCliEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of Object.keys(process.env)) {
		if (key === 'ELECTRON_RUN_AS_NODE' || key === 'NODE_OPTIONS') {
			continue;
		}
		if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_')) {
			continue;
		}
		env[key] = process.env[key];
	}
	return env;
}

/**
 * Create a CLI-backed {@link WarmQuery}. The subprocess is spawned lazily on the
 * first (only) `query()` call. On spawn the transport writes the `initialize`
 * control request, then simply blocks on stdin until the first user message
 * arrives.
 *
 * `spawnFn` defaults to the real {@link spawn}; it is injectable so tests can
 * drive the transport over fake stdio streams without launching a process.
 */
export function createClaudeCliWarmQuery(
	options: Options,
	executablePath: string,
	logService: ILogService,
	spawnFn: typeof spawn = spawn,
): WarmQuery {
	let child: ChildProcess | undefined;
	let killed = false;

	const killChild = () => {
		if (child && !killed) {
			killed = true;
			try {
				child.kill();
			} catch (err) {
				logService.warn(`[Claude CLI] failed to kill child: ${err}`);
			}
		}
	};

	const abortSignal = options.abortController?.signal;
	abortSignal?.addEventListener('abort', killChild, { once: true });

	const startQuery = (prompt: string | AsyncIterable<SDKUserMessage>): Query => {
		const args = buildCliArgs(options);
		const cwd = typeof options.cwd === 'string' ? options.cwd : undefined;
		logService.info(`[Claude CLI] spawning ${executablePath} ${args.join(' ')} (cwd=${cwd ?? process.cwd()})`);
		const proc = spawnFn(executablePath, args, {
			cwd,
			env: buildCliEnv(),
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		child = proc;
		if (abortSignal?.aborted) {
			killChild();
		}

		proc.on('error', err => logService.error(`[Claude CLI] spawn error: ${err}`));
		proc.stderr?.setEncoding('utf8');
		proc.stderr?.on('data', (data: string) => logService.info(`[Claude CLI stderr] ${data.trimEnd()}`));

		// `initialize` control handshake. The SDK's own transport sends this on
		// warm-up; we mirror it so the CLI replies with a `control_response`
		// carrying the account's available models (resolved into `initialization`
		// when the matching frame is seen in `messages()`). Written before the
		// user-message pump so it is the first frame the CLI reads.
		const initRequestId = `init_${++controlRequestSeq}`;
		const initialization = new DeferredPromise<SDKControlInitializeResponse>();
		// Swallow rejections on the bare promise so a failed handshake with no
		// awaiting consumer doesn't surface as an unhandled rejection (the SDK's
		// own transport does the same). Real consumers still observe the error.
		initialization.p.catch(() => { });
		try {
			const initFrame = { type: 'control_request', request_id: initRequestId, request: { subtype: 'initialize' } };
			proc.stdin?.write(JSON.stringify(initFrame) + '\n');
		} catch (err) {
			logService.warn(`[Claude CLI] failed to write initialize control request: ${err}`);
		}
		// If the child dies before answering, fail `initialization` so callers
		// (e.g. model discovery) reject fast and fall back rather than hang.
		proc.on('exit', () => {
			if (!initialization.isSettled) {
				initialization.error(new Error('[Claude CLI] process exited before the initialize handshake completed'));
			}
		});

		// Pump the prompt queue iterable to the child's stdin as newline-
		// delimited JSON (one SDKUserMessage per line). When the iterable
		// completes (the queue returns done on abort), close stdin so the CLI
		// exits cleanly.
		const iterable: AsyncIterable<SDKUserMessage> = typeof prompt === 'string'
			? (async function* () {
				yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null } satisfies SDKUserMessage;
			})()
			: prompt;
		void (async () => {
			try {
				for await (const message of iterable) {
					if (!proc.stdin || proc.stdin.destroyed) {
						break;
					}
					proc.stdin.write(JSON.stringify(message) + '\n');
				}
			} catch (err) {
				logService.warn(`[Claude CLI] stdin pump error: ${err}`);
			} finally {
				proc.stdin?.end();
			}
		})();

		const lines = new LineReader(proc.stdout!);
		async function* messages(): AsyncGenerator<SDKMessage, void> {
			for await (const line of lines) {
				const trimmed = line.trim();
				if (trimmed.length === 0) {
					continue;
				}
				let parsed: SDKMessage;
				try {
					parsed = JSON.parse(trimmed) as SDKMessage;
				} catch (err) {
					logService.warn(`[Claude CLI] failed to parse line, skipping: ${err}`);
					continue;
				}
				// Control-protocol frames are part of the transport, not the
				// message stream — handle them here and never yield them to the
				// pipeline (which only understands SDKMessages).
				const frameType = (parsed as { type?: string }).type;
				if (frameType === 'control_response') {
					const { response } = parsed as unknown as ICliControlResponseFrame;
					if (response?.request_id === initRequestId && !initialization.isSettled) {
						if (response.subtype === 'success' && response.response) {
							initialization.complete(response.response);
						} else {
							initialization.error(new Error(`[Claude CLI] initialize failed: ${response.error ?? 'unknown error'}`));
						}
					}
					continue;
				}
				if (frameType === 'control_request') {
					// CLI→client control requests (e.g. `can_use_tool`) are not
					// handled by this MVP transport — permission handling is driven
					// by the `--permission-mode` spawn flag. Swallow rather than yield.
					logService.trace('[Claude CLI] ignoring inbound control_request');
					continue;
				}
				yield parsed;
			}
		}

		// The pipeline only drives the subset below; the remaining ~25 Query
		// control methods are not part of the CLI transport. A single localized
		// cast keeps us from hand-stubbing an evolving 25-method interface whose
		// other members the pipeline never calls.
		const query = Object.assign(messages(), {
			interrupt: async (): Promise<void> => { killChild(); },
			setModel: async (model?: string): Promise<void> => {
				logService.info(`[Claude CLI] setModel(${model}) ignored mid-session (applies on next session restart)`);
			},
			setPermissionMode: async (): Promise<void> => {
				logService.info('[Claude CLI] setPermissionMode ignored mid-session (applies on next session restart)');
			},
			applyFlagSettings: async (): Promise<void> => {
				logService.info('[Claude CLI] applyFlagSettings ignored mid-session');
			},
			// Backed by the `initialize` handshake above — the only control
			// method this transport answers with real data.
			supportedModels: async (): Promise<ModelInfo[]> => (await initialization.p).models,
			supportedCommands: async () => [],
			supportedAgents: async () => [],
			mcpServerStatus: async () => [],
			reloadPlugins: async () => ({ commands: [], agents: [], plugins: [], mcpServers: [] }),
		});
		return query as unknown as Query;
	};

	return {
		query: startQuery,
		close: killChild,
		[Symbol.asyncDispose]: async (): Promise<void> => { killChild(); },
	};
}
