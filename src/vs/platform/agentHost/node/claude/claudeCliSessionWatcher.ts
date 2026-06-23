/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { promises as fs } from 'fs';
import { FileChangesEvent, IFileService } from '../../../files/common/files.js';
import { ILogService } from '../../../log/common/log.js';
import { claudeConfigDir } from './claudeCliSessionStore.js';

/**
 * Authoritative live status of a Claude CLI session, read straight from the
 * native CLI's own per-process state file. Mirrors the categories the
 * `claude agents` TUI surfaces:
 *
 * - `busy` — a turn is actively running ("working").
 * - `waiting` — the turn is blocked on the user ("awaiting input").
 * - `idle` — at the prompt with nothing running ("completed").
 */
export type ClaudeCliSessionStatus = 'busy' | 'waiting' | 'idle';

export interface IClaudeCliSessionChange {
	readonly sessionId: string;
	readonly status: ClaudeCliSessionStatus;
}

/**
 * A single `claude` process changed its session id — the hallmark of the
 * `/clear` slash command, which abandons the current conversation and starts a
 * fresh session id within the *same* process. `from` is the abandoned id, `to`
 * the new one.
 */
export interface IClaudeCliSessionReplace {
	readonly from: string;
	readonly to: string;
}

/** Shape of `<configDir>/sessions/<pid>.json` (only the fields we read). */
interface IClaudeSessionStateFile {
	readonly sessionId?: string;
	readonly status?: string;
	readonly statusUpdatedAt?: number;
	readonly pid?: number;
}

/**
 * Watches the native `claude` CLI's per-process session state store
 * (`<configDir>/sessions/<pid>.json`) and surfaces each session's real
 * working / awaiting-input / completed status.
 *
 * Claude runs terminal-only: sessions are created and advanced by an external
 * `claude` process that the agent host does not orchestrate, so there is no
 * in-process turn lifecycle to observe. Each interactive `claude` process,
 * however, continuously writes its own state file (the same source the
 * `claude agents` TUI reads), giving an authoritative status without polling
 * the transcript or guessing from write activity. The state file also carries
 * the `sessionId`, so a brand-new session is discovered the moment its process
 * starts.
 */
export class ClaudeCliSessionWatcher extends Disposable {

	/** Coalesce the bursts of writes a running CLI produces into one rescan. */
	private static readonly RESCAN_DEBOUNCE_MS = 300;

	private readonly _onDidChangeSession = this._register(new Emitter<IClaudeCliSessionChange>());
	readonly onDidChangeSession: Event<IClaudeCliSessionChange> = this._onDidChangeSession.event;

	private readonly _onDidReplaceSession = this._register(new Emitter<IClaudeCliSessionReplace>());
	readonly onDidReplaceSession: Event<IClaudeCliSessionReplace> = this._onDidReplaceSession.event;

	/** Last known status per session id. Sessions absent here are treated as `idle`. */
	private readonly _statuses = new Map<string, ClaudeCliSessionStatus>();

	/** Last known session id per live process, to detect a `/clear` continuation (same pid, new id). */
	private readonly _pidSession = new Map<number, string>();

	/**
	 * Session ids abandoned by a `/clear` continuation whose new id now carries
	 * the conversation. Kept so the agent can hide the abandoned id from the
	 * session list instead of leaving an orphan row. An id is dropped from here
	 * if a live process reports it again (e.g. it is explicitly resumed).
	 */
	private readonly _superseded = new Set<string>();

	private readonly _stateDir = join(claudeConfigDir(), 'sessions');

	private readonly _rescanScheduler = this._register(new RunOnceScheduler(() => this._rescan(), ClaudeCliSessionWatcher.RESCAN_DEBOUNCE_MS));

	constructor(
		private readonly _fileService: IFileService,
		private readonly _logService: ILogService,
	) {
		super();
		this._start();
	}

	/** Current live status for a session, or `undefined` when it is not running. */
	statusFor(sessionId: string): ClaudeCliSessionStatus | undefined {
		return this._statuses.get(sessionId);
	}

	/** Whether a `/clear` continuation has abandoned this session id for a new one. */
	isSuperseded(sessionId: string): boolean {
		return this._superseded.has(sessionId);
	}

	private _start(): void {
		const dir = URI.file(this._stateDir);
		try {
			this._register(this._fileService.watch(dir, { recursive: true, excludes: [] }));
		} catch (err) {
			this._logService.warn(`[Claude CLI] Failed to watch ${this._stateDir} for live session status`, err);
			return;
		}
		this._register(this._fileService.onDidFilesChange(e => {
			if (this._affectsStateDir(e)) {
				this._rescanScheduler.schedule();
			}
		}));
		// Seed the status map so `statusFor` is populated for the first
		// `listSessions` call; running sessions emit on this first pass.
		this._rescan();
		this._logService.info(`[Claude CLI] Watching ${this._stateDir} for live session status`);
	}

	private _affectsStateDir(e: FileChangesEvent): boolean {
		const prefix = this._stateDir + '/';
		const matches = (resource: URI) => resource.fsPath.startsWith(prefix);
		return e.rawAdded.some(matches) || e.rawUpdated.some(matches) || e.rawDeleted.some(matches);
	}

	private async _rescan(): Promise<void> {
		let files: string[];
		try {
			files = await fs.readdir(this._stateDir);
		} catch {
			files = [];
		}

		// Build the current status per session from the live processes. When
		// several processes share a session id (e.g. a resumed session), the
		// most recently updated state wins. Stale files left by a crashed
		// process are skipped via the liveness check so a session never sticks
		// on `busy` forever.
		const current = new Map<string, { status: ClaudeCliSessionStatus; updatedAt: number }>();
		// Session id per live pid this scan, to spot a `/clear` continuation.
		const currentPidSession = new Map<number, string>();
		await Promise.all(files.map(async name => {
			if (!name.endsWith('.json')) {
				return;
			}
			let state: IClaudeSessionStateFile;
			try {
				state = JSON.parse(await fs.readFile(join(this._stateDir, name), 'utf8'));
			} catch {
				return;
			}
			const sessionId = state.sessionId;
			const status = normalizeStatus(state.status);
			if (!sessionId || !status || !isProcessAlive(state.pid)) {
				return;
			}
			if (typeof state.pid === 'number') {
				currentPidSession.set(state.pid, sessionId);
			}
			const updatedAt = typeof state.statusUpdatedAt === 'number' ? state.statusUpdatedAt : 0;
			const existing = current.get(sessionId);
			if (!existing || updatedAt >= existing.updatedAt) {
				current.set(sessionId, { status, updatedAt });
			}
		}));

		// Detect `/clear` continuations: a live pid whose session id changed
		// since the last scan. Drive this strictly off the per-pid map (never the
		// by-session `current` map, which collapses shared ids). Only treat it as
		// a replace when no *other* live process still holds the old id, so a
		// resumed session shared across processes is not wrongly retired.
		const replacements: IClaudeCliSessionReplace[] = [];
		for (const [pid, to] of currentPidSession) {
			const from = this._pidSession.get(pid);
			if (from !== undefined && from !== to && !current.has(from)) {
				replacements.push({ from, to });
				this._superseded.add(from);
			}
		}
		// A session reported live again (e.g. explicitly resumed) is no longer
		// superseded.
		for (const sessionId of current.keys()) {
			this._superseded.delete(sessionId);
		}
		this._pidSession.clear();
		for (const [pid, sessionId] of currentPidSession) {
			this._pidSession.set(pid, sessionId);
		}

		// Diff against the previous snapshot and emit per changed session. A
		// session that dropped out of `current` (its process exited) settles to
		// `idle`.
		const changed: IClaudeCliSessionChange[] = [];
		for (const [sessionId, { status }] of current) {
			if ((this._statuses.get(sessionId) ?? 'idle') !== status) {
				changed.push({ sessionId, status });
			}
		}
		for (const sessionId of this._statuses.keys()) {
			if (!current.has(sessionId)) {
				changed.push({ sessionId, status: 'idle' });
			}
		}

		this._statuses.clear();
		for (const [sessionId, { status }] of current) {
			this._statuses.set(sessionId, status);
		}

		// Fire the `/clear` continuations first so a client re-keys the live
		// terminal A→B before A would otherwise settle to `idle` below.
		for (const replace of replacements) {
			this._onDidReplaceSession.fire(replace);
		}
		for (const change of changed) {
			this._onDidChangeSession.fire(change);
		}
	}
}

function normalizeStatus(raw: string | undefined): ClaudeCliSessionStatus | undefined {
	switch (raw) {
		case 'busy': return 'busy';
		case 'waiting': return 'waiting';
		case 'idle': return 'idle';
		default: return undefined;
	}
}

/** Whether the process is still running, so a stale state file is ignored. */
function isProcessAlive(pid: number | undefined): boolean {
	if (typeof pid !== 'number') {
		return false;
	}
	try {
		// Signal 0 performs existence/permission checks without delivering a
		// signal: it throws `ESRCH` when the process is gone and `EPERM` when
		// it exists but is owned by another user (still alive).
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}
