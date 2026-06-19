/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelInfo, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChildProcess, spawn } from 'child_process';
import assert from 'assert';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { createClaudeCliWarmQuery } from '../../node/claude/claudeCliQuery.js';

/**
 * Minimal in-memory stand-in for the `claude` child process. Exposes exactly
 * the surface {@link createClaudeCliWarmQuery} touches (stdin writes, stdout /
 * stderr streams, `kill`, `error` / `exit` events) so the control-protocol
 * handshake can be exercised over fake stdio without launching a binary.
 */
interface IFakeChild {
	readonly proc: ChildProcess;
	/** Newline-delimited frames written to the child's stdin. */
	readonly stdinChunks: string[];
	/** Push a stdout line (frame) the transport will read. */
	emitStdout(frame: object): void;
	/** Close stdout so the message iterator completes. */
	endStdout(): void;
}

function createFakeChild(): IFakeChild {
	const stdinChunks: string[] = [];
	const stdin = {
		destroyed: false,
		write(chunk: string): boolean { stdinChunks.push(chunk); return true; },
		end(): void { this.destroyed = true; },
	};
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const emitter = new EventEmitter();
	const proc = Object.assign(emitter, {
		stdin,
		stdout,
		stderr,
		kill(): boolean { emitter.emit('exit', 0, null); return true; },
	}) as unknown as ChildProcess;
	return {
		proc,
		stdinChunks,
		emitStdout: (frame: object) => stdout.write(JSON.stringify(frame) + '\n'),
		endStdout: () => stdout.end(),
	};
}

/** Parse the `initialize` control request the transport wrote to stdin and return its `request_id`. */
function readInitRequestId(stdinChunks: string[]): string {
	const frame = stdinChunks
		.map(chunk => JSON.parse(chunk.trim()) as { type?: string; request_id?: string; request?: { subtype?: string } })
		.find(f => f.type === 'control_request' && f.request?.subtype === 'initialize');
	assert.ok(frame?.request_id, 'transport should write an initialize control request');
	return frame.request_id;
}

async function drain(query: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
	const out: SDKMessage[] = [];
	for await (const message of query) {
		out.push(message);
	}
	return out;
}

suite('createClaudeCliWarmQuery', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const MODELS: ModelInfo[] = [
		{ value: 'claude-opus-4-5', displayName: 'Claude Opus 4.5', description: 'flagship', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
		{ value: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', description: 'fast' },
	];

	test('initialize handshake surfaces models and filters control frames from the message stream', async () => {
		const fake = createFakeChild();
		const fakeSpawn = (() => fake.proc) as unknown as typeof spawn;
		const warm = createClaudeCliWarmQuery({} as Options, 'claude', new NullLogService(), fakeSpawn);

		// Empty prompt iterable — the handshake is independent of user messages.
		const query = warm.query((async function* () { })()) as unknown as AsyncIterable<SDKMessage> & { supportedModels(): Promise<ModelInfo[]> };
		const requestId = readInitRequestId(fake.stdinChunks);

		const systemMessage = { type: 'system', subtype: 'init', model: 'claude-opus-4-5', session_id: 's1' };
		const drained = drain(query);
		fake.emitStdout({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { commands: [], agents: [], output_style: 'default', available_output_styles: [], models: MODELS, account: { email: 'a@b.c' } } } });
		fake.emitStdout(systemMessage);
		fake.endStdout();

		const messages = await drained;
		const models = await query.supportedModels();

		assert.deepStrictEqual({ models, messages }, { models: MODELS, messages: [systemMessage] });
	});

	test('handshake rejects when the child exits before responding', async () => {
		const fake = createFakeChild();
		const fakeSpawn = (() => fake.proc) as unknown as typeof spawn;
		const warm = createClaudeCliWarmQuery({} as Options, 'claude', new NullLogService(), fakeSpawn);
		const query = warm.query((async function* () { })()) as unknown as AsyncIterable<SDKMessage> & { supportedModels(): Promise<ModelInfo[]> };

		const rejection = assert.rejects(() => query.supportedModels());
		fake.proc.kill();
		fake.endStdout();
		await drain(query);
		await rejection;
	});
});
