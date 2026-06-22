/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { IObservable, IReader, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ITerminalLaunchError, IShellLaunchConfig, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { AgentSessionProviders } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessions.js';
import { ITerminalInstance, ITerminalService, TerminalConnectionState } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ISession, SessionStatus } from '../../sessions/common/session.js';
import { IActiveSession, ISessionsManagementService } from '../../sessions/common/sessionsManagement.js';

export const ISessionTerminalService = createDecorator<ISessionTerminalService>('sessionTerminalService');

/**
 * Reconnection owner tag for embedded session terminals, used so they can be
 * re-associated to their session after a window reload (the pty host persists
 * them; reconnected instances are matched back by this owner id and the
 * `sessionId` stored in {@link IReconnectionProperties.data}).
 */
export const SESSION_TERMINAL_OWNER = 'sessions.claudeTerminal';

/**
 * Eligibility result for {@link getNativeTerminalLaunch}: the local working
 * directory the terminal should launch in, and the session id to resume.
 */
export interface INativeTerminalLaunch {
	readonly cwd: URI;
	/**
	 * When set, the terminal resumes this existing conversation
	 * (`claude --resume <id>`). `undefined` for a brand-new session, which
	 * launches a fresh `claude` with no transcript to resume.
	 */
	readonly resumeSessionId: string | undefined;
}

/**
 * Returns how to launch an embedded native `claude` terminal for a session, or
 * `undefined` when the session cannot host one.
 *
 * A session qualifies when it is backed by the local Claude agent host (its
 * resource scheme is `agent-host-claude`) and has a local working directory.
 * Remote agent-host sessions use a different scheme and are excluded — a local
 * `claude` CLI cannot reach a remote worktree.
 *
 * - **Created** sessions resume their conversation: the session resource's path
 *   is the same id the Claude SDK wrote the on-disk transcript under, so
 *   `claude --resume <id>` in {@link INativeTerminalLaunch.cwd} resumes the very
 *   conversation started through the SDK.
 * - **Uncreated** (untitled) sessions have no SDK transcript yet, so they launch
 *   a fresh `claude` in the workspace ({@link INativeTerminalLaunch.resumeSessionId}
 *   is `undefined`). This is how new sessions work in terminal mode: the user
 *   talks to the native CLI directly instead of sending through the SDK.
 *
 * Pass a {@link reader} from an autorun so the result reacts to the workspace
 * resolving. Shared by {@link SessionView} (to decide the view kind) and
 * {@link SessionTerminalService} (to build the terminal) so both agree on what
 * qualifies.
 */
export function getNativeTerminalLaunch(session: ISession, reader?: IReader): INativeTerminalLaunch | undefined {
	if (session.resource.scheme !== AgentSessionProviders.AgentHostClaude) {
		return undefined;
	}
	const workspace = reader ? session.workspace.read(reader) : session.workspace.get();
	const cwd = workspace?.folders[0]?.workingDirectory;
	if (!cwd || cwd.scheme !== Schemas.file) {
		return undefined;
	}
	const isCreated = (reader ? session.status.read(reader) : session.status.get()) !== SessionStatus.Untitled;
	const resumeSessionId = isCreated ? session.resource.path.substring(1) || undefined : undefined;
	return { cwd, resumeSessionId };
}

/**
 * Owns the embedded native `claude` terminal instances for the Agents Window —
 * one per session, reused across view re-creations and session switches so a
 * session keeps a single terminal. Terminals persist across window reloads and
 * are re-associated to their session on revival.
 */
export interface ISessionTerminalService {

	readonly _serviceBrand: undefined;

	/**
	 * The set of brand-new (untitled) session ids that have been switched to the
	 * terminal via {@link openNewSessionTerminal}. Read by {@link SessionView} so
	 * a new session stays on the composer until the user submits a message, then
	 * flips to the terminal. (Created sessions resume their terminal immediately
	 * and are not tracked here.)
	 */
	readonly terminalSessionIds: IObservable<ReadonlySet<string>>;

	/**
	 * Returns (creating if necessary) the terminal running the native `claude`
	 * CLI for the given session, or `undefined` when the session is not eligible
	 * (see {@link getNativeTerminalLaunch}). Created sessions resume their
	 * conversation; a brand-new session launches a fresh `claude` (optionally
	 * seeded with the prompt captured by {@link openNewSessionTerminal}).
	 *
	 * Pass `fresh` to force a brand-new `claude` (no `--resume`) even for a
	 * created session — used to recover when resuming a session whose transcript
	 * the CLI cannot load (`claude --resume <id>` exited non-zero).
	 */
	getOrCreateTerminal(session: IActiveSession, fresh?: boolean): Promise<ITerminalInstance | undefined>;

	/**
	 * Switches a brand-new (untitled) session to the terminal, seeding `claude`
	 * with the message the user submitted in the composer. Marks the session in
	 * {@link terminalSessionIds} so {@link SessionView} flips it to the terminal,
	 * then lazily launches `claude "<initialPrompt>"`.
	 */
	openNewSessionTerminal(session: IActiveSession, initialPrompt: string): void;

	/** The terminal already created for a session, if any. */
	getTerminal(sessionId: string): ITerminalInstance | undefined;

	/** Disposes (kills) the terminal for a session. */
	disposeTerminal(sessionId: string): void;
}

export class SessionTerminalService extends Disposable implements ISessionTerminalService {

	declare readonly _serviceBrand: undefined;

	/**
	 * Session id -> its embedded terminal. A plain map: the terminal instances
	 * are owned by the terminal service (and persist via the pty host), so this
	 * service must not dispose them when it shuts down — it only kills them
	 * explicitly when a session is removed.
	 */
	private readonly _terminals = new Map<string, ITerminalInstance>();

	/** Initial `claude` prompt for a brand-new session, captured from the composer. */
	private readonly _initialPrompts = new Map<string, string>();

	private readonly _terminalSessionIds = observableValue<ReadonlySet<string>>(this, new Set());
	readonly terminalSessionIds: IObservable<ReadonlySet<string>> = this._terminalSessionIds;

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Re-associate terminals revived by the pty host after a reload back to
		// their session. Some already exist when this service is constructed;
		// others arrive asynchronously during reconnection via onDidCreateInstance.
		for (const instance of this.terminalService.instances) {
			this._adoptRevivedTerminal(instance);
		}
		this._register(this.terminalService.onDidCreateInstance(instance => this._adoptRevivedTerminal(instance)));

		// Kill a session's terminal when the session is removed; transfer it on
		// untitled -> committed graduation so it is not orphaned and killed.
		this._register(this.sessionsManagementService.onDidChangeSessions(e => {
			for (const session of e.removed) {
				this.disposeTerminal(session.sessionId);
			}
		}));
		this._register(this.sessionsManagementService.onDidReplaceSession(({ from, to }) => {
			const instance = this._terminals.get(from.sessionId);
			if (instance) {
				this._terminals.delete(from.sessionId);
				this._terminals.set(to.sessionId, instance);
			}
			const prompt = this._initialPrompts.get(from.sessionId);
			if (prompt !== undefined) {
				this._initialPrompts.delete(from.sessionId);
				this._initialPrompts.set(to.sessionId, prompt);
			}
			if (this._terminalSessionIds.get().has(from.sessionId)) {
				const next = new Set(this._terminalSessionIds.get());
				next.delete(from.sessionId);
				next.add(to.sessionId);
				this._terminalSessionIds.set(next, undefined);
			}
		}));
	}

	getTerminal(sessionId: string): ITerminalInstance | undefined {
		const instance = this._terminals.get(sessionId);
		return instance && !instance.isDisposed ? instance : undefined;
	}

	async getOrCreateTerminal(session: IActiveSession, fresh?: boolean): Promise<ITerminalInstance | undefined> {
		const launch = getNativeTerminalLaunch(session);
		if (!launch) {
			return undefined;
		}

		const existing = this.getTerminal(session.sessionId);
		if (existing) {
			return existing;
		}

		// After a window reload the session's persisted terminal is revived
		// asynchronously (adopted by `_adoptRevivedTerminal` via
		// `onDidCreateInstance` during reconnection). The view attaches
		// immediately, so without waiting we could race ahead of that adoption and
		// launch a *second* `claude --resume <id>` for a session that already has a
		// live process. Wait for reconnection to settle, then re-check, so a revived
		// terminal is reused instead of duplicated.
		if (this.terminalService.connectionState !== TerminalConnectionState.Connected) {
			await this.terminalService.whenConnected;
			const revived = this.getTerminal(session.sessionId) ?? this._findReconnectedTerminal(session.sessionId);
			if (revived) {
				return revived;
			}
		}

		// When recovering from a failed resume, ignore the resume id and launch a
		// brand-new `claude` instead.
		const resumeSessionId = fresh ? undefined : launch.resumeSessionId;
		const executable = 'claude';
		const initialPrompt = this._initialPrompts.get(session.sessionId);
		const config: IShellLaunchConfig = {
			executable,
			// Resume the SDK-started conversation for created sessions; for a
			// brand-new session launch a fresh `claude`, seeded with the prompt the
			// user submitted in the composer when present.
			args: resumeSessionId
				? ['--resume', resumeSessionId]
				: (initialPrompt ? [initialPrompt] : []),
			cwd: launch.cwd,
			name: 'Claude',
			icon: Codicon.terminal,
			// Inherit the login-shell environment so the native CLI uses the
			// user's own Claude login (ambient auth) rather than the SDK's
			// Copilot proxy.
			useShellEnvironment: true,
			// Hosted in the session grid leaf, not the terminal panel. `forcePersist`
			// is required so a `hideFromUser` terminal still survives reloads.
			hideFromUser: true,
			isFeatureTerminal: true,
			forcePersist: true,
			// This terminal surfaces its own exit state through {@link TerminalChatView};
			// suppress the global "terminated with exit code" notification it would
			// otherwise leak (it is never opened directly by the user).
			ignoreShellProcessExitNotification: true,
			reconnectionProperties: {
				ownerId: SESSION_TERMINAL_OWNER,
				data: { sessionId: session.sessionId, resumeSessionId } satisfies ISessionTerminalReconnectionData,
			},
		};

		const instance = await this.terminalService.createTerminal({ config, location: TerminalLocation.Panel });
		this._track(session.sessionId, instance);
		return instance;
	}

	openNewSessionTerminal(session: IActiveSession, initialPrompt: string): void {
		const trimmed = initialPrompt.trim();
		if (trimmed) {
			this._initialPrompts.set(session.sessionId, trimmed);
		}
		const next = new Set(this._terminalSessionIds.get());
		next.add(session.sessionId);
		this._terminalSessionIds.set(next, undefined);
	}

	disposeTerminal(sessionId: string): void {
		this._initialPrompts.delete(sessionId);
		if (this._terminalSessionIds.get().has(sessionId)) {
			const next = new Set(this._terminalSessionIds.get());
			next.delete(sessionId);
			this._terminalSessionIds.set(next, undefined);
		}
		const instance = this._terminals.get(sessionId);
		if (instance) {
			this._terminals.delete(sessionId);
			if (!instance.isDisposed) {
				this.terminalService.safeDisposeTerminal(instance).catch(err => this.logService.error('[SessionTerminal] Failed to dispose terminal', err));
			}
		}
	}

	private _track(sessionId: string, instance: ITerminalInstance): void {
		this._terminals.set(sessionId, instance);
		// Tie listeners to the instance's own lifecycle so they are cleaned up
		// when the pty is disposed (the instance, not this service, owns them).
		instance.store.add(instance.onDisposed(() => {
			if (this._terminals.get(sessionId) === instance) {
				this._terminals.delete(sessionId);
			}
		}));
		// Surface a clear error if the native CLI could not be launched (e.g.
		// `claude` not on PATH) rather than leaving an empty terminal.
		instance.store.add(instance.onExit(exit => this._onTerminalExit(exit)));
	}

	private _onTerminalExit(exit: number | ITerminalLaunchError | undefined): void {
		const launchFailed = exit !== undefined && typeof exit === 'object';
		const notFound = exit === 127;
		if (launchFailed || notFound) {
			this.notificationService.notify({
				severity: Severity.Warning,
				message: localize('claudeCliLaunchFailed', "The Claude CLI could not be started. Make sure `claude` is installed and on your PATH."),
			});
		}
	}

	/**
	 * Finds a reconnected (post-reload) terminal belonging to the given session
	 * that has not been adopted yet and tracks it, returning the instance. Guards
	 * {@link getOrCreateTerminal} against launching a duplicate `claude` when the
	 * revived terminal's `onDidCreateInstance` adoption has not fired by the time
	 * reconnection completes.
	 */
	private _findReconnectedTerminal(sessionId: string): ITerminalInstance | undefined {
		const reconnected = this.terminalService.getReconnectedTerminals(SESSION_TERMINAL_OWNER);
		const match = reconnected?.find(instance => {
			const data = instance.reconnectionProperties?.data as ISessionTerminalReconnectionData | undefined;
			return data?.sessionId === sessionId && !instance.isDisposed;
		});
		if (match) {
			this._adoptRevivedTerminal(match);
			return this.getTerminal(sessionId);
		}
		return undefined;
	}

	private _adoptRevivedTerminal(instance: ITerminalInstance): void {
		if (instance.reconnectionProperties?.ownerId !== SESSION_TERMINAL_OWNER) {
			return;
		}
		const data = instance.reconnectionProperties.data as ISessionTerminalReconnectionData | undefined;
		if (!data?.sessionId || this._terminals.get(data.sessionId) === instance) {
			return;
		}
		this.logService.trace(`[SessionTerminal] Re-associated revived terminal ${instance.instanceId} with session ${data.sessionId}`);
		this._track(data.sessionId, instance);
	}
}

/** Shape stored in {@link IReconnectionProperties.data} for embedded session terminals. */
interface ISessionTerminalReconnectionData {
	readonly sessionId: string;
	readonly resumeSessionId: string | undefined;
}
