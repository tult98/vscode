/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileChangesEvent, FileChangeType, IFileChange, IFileService } from '../../../../files/common/files.js';
import { NullLogService } from '../../../../log/common/log.js';
import { ClaudeCliSessionWatcher, IClaudeCliSessionChange, IClaudeCliSessionReplace } from '../../../node/claude/claudeCliSessionWatcher.js';

suite('ClaudeCliSessionWatcher', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const ALIVE_PID = process.pid;
	// The parent process is alive for the duration of the test run, giving a
	// second distinct live pid for the shared-session-id case.
	const ALIVE_PID_2 = process.ppid;
	const DEAD_PID = 2147483646;

	let configDir: string;
	let stateDir: string;
	let originalConfigDir: string | undefined;

	async function writeState(fileName: string, state: object): Promise<void> {
		await fs.writeFile(join(stateDir, fileName), JSON.stringify(state), 'utf8');
	}

	function createFakeFileService(): { service: IFileService; fire: (changes: IFileChange[]) => void } {
		const onDidFilesChange = store.add(new Emitter<FileChangesEvent>());
		const service = {
			onDidFilesChange: onDidFilesChange.event,
			watch(): IDisposable { return Disposable.None; },
		} as unknown as IFileService;
		return { service, fire: changes => onDidFilesChange.fire(new FileChangesEvent(changes, false)) };
	}

	function collect(watcher: ClaudeCliSessionWatcher): IClaudeCliSessionChange[] {
		const events: IClaudeCliSessionChange[] = [];
		store.add(watcher.onDidChangeSession(e => events.push(e)));
		return events;
	}

	function collectReplace(watcher: ClaudeCliSessionWatcher): IClaudeCliSessionReplace[] {
		const events: IClaudeCliSessionReplace[] = [];
		store.add(watcher.onDidReplaceSession(e => events.push(e)));
		return events;
	}

	const bySessionId = (a: IClaudeCliSessionChange, b: IClaudeCliSessionChange) => a.sessionId.localeCompare(b.sessionId);

	setup(async () => {
		originalConfigDir = process.env['CLAUDE_CONFIG_DIR'];
		configDir = join(os.tmpdir(), `claude-watcher-test-${generateUuid()}`);
		stateDir = join(configDir, 'sessions');
		await fs.mkdir(stateDir, { recursive: true });
		process.env['CLAUDE_CONFIG_DIR'] = configDir;
	});

	teardown(async () => {
		if (originalConfigDir === undefined) {
			delete process.env['CLAUDE_CONFIG_DIR'];
		} else {
			process.env['CLAUDE_CONFIG_DIR'] = originalConfigDir;
		}
		await fs.rm(configDir, { recursive: true, force: true });
	});

	test('initial scan reports live working / awaiting-input, picks latest, skips dead and idle', async () => {
		await writeState('1.json', { sessionId: 'busy-session', status: 'busy', pid: ALIVE_PID, statusUpdatedAt: 1 });
		await writeState('2.json', { sessionId: 'waiting-session', status: 'waiting', pid: ALIVE_PID, statusUpdatedAt: 1 });
		await writeState('3.json', { sessionId: 'idle-session', status: 'idle', pid: ALIVE_PID, statusUpdatedAt: 1 });
		// A crashed process left a stale `busy` file — must be ignored.
		await writeState('4.json', { sessionId: 'stale-session', status: 'busy', pid: DEAD_PID, statusUpdatedAt: 1 });
		// Same session across two processes: the most recently updated wins.
		await writeState('5.json', { sessionId: 'resumed-session', status: 'idle', pid: ALIVE_PID, statusUpdatedAt: 10 });
		await writeState('6.json', { sessionId: 'resumed-session', status: 'busy', pid: ALIVE_PID, statusUpdatedAt: 20 });

		const { service } = createFakeFileService();
		const watcher = store.add(new ClaudeCliSessionWatcher(service, new NullLogService()));
		const events = collect(watcher);

		// Let the constructor's initial (non-debounced) rescan settle.
		await timeout(50);

		// Only non-idle live sessions emit on the first pass.
		assert.deepStrictEqual([...events].sort(bySessionId), [
			{ sessionId: 'busy-session', status: 'busy' },
			{ sessionId: 'resumed-session', status: 'busy' },
			{ sessionId: 'waiting-session', status: 'waiting' },
		]);
		assert.strictEqual(watcher.statusFor('idle-session'), 'idle');
		assert.strictEqual(watcher.statusFor('stale-session'), undefined);
		assert.strictEqual(watcher.statusFor('resumed-session'), 'busy');
	});

	test('a status change on disk is surfaced after a state-dir file event', async () => {
		await writeState('1.json', { sessionId: 'abc', status: 'busy', pid: ALIVE_PID, statusUpdatedAt: 1 });

		const { service, fire } = createFakeFileService();
		const watcher = store.add(new ClaudeCliSessionWatcher(service, new NullLogService()));
		const events = collect(watcher);
		await timeout(50);
		assert.deepStrictEqual(events, [{ sessionId: 'abc', status: 'busy' }]);

		// The turn finishes: the CLI rewrites the state file to `idle`.
		await writeState('1.json', { sessionId: 'abc', status: 'idle', pid: ALIVE_PID, statusUpdatedAt: 2 });
		fire([{ resource: URI.file(join(stateDir, '1.json')), type: FileChangeType.UPDATED }]);
		await timeout(400); // past the rescan debounce

		assert.deepStrictEqual(events, [
			{ sessionId: 'abc', status: 'busy' },
			{ sessionId: 'abc', status: 'idle' },
		]);
	});

	test('a `/clear` continuation (same pid, new session id) emits one replace and supersedes the old id', async () => {
		await writeState('1.json', { sessionId: 'A', status: 'busy', pid: ALIVE_PID, statusUpdatedAt: 1 });

		const { service, fire } = createFakeFileService();
		const watcher = store.add(new ClaudeCliSessionWatcher(service, new NullLogService()));
		const replaces = collectReplace(watcher);
		await timeout(50);
		assert.deepStrictEqual(replaces, []);

		// `/clear`: the same process rewrites its state file with a fresh id.
		await writeState('1.json', { sessionId: 'B', status: 'busy', pid: ALIVE_PID, statusUpdatedAt: 2 });
		fire([{ resource: URI.file(join(stateDir, '1.json')), type: FileChangeType.UPDATED }]);
		await timeout(400);

		assert.deepStrictEqual(replaces, [{ from: 'A', to: 'B' }]);
		assert.strictEqual(watcher.isSuperseded('A'), true);
		assert.strictEqual(watcher.isSuperseded('B'), false);
	});

	test('a process simply exiting does not emit a replace or supersede its id', async () => {
		await writeState('1.json', { sessionId: 'A', status: 'busy', pid: ALIVE_PID, statusUpdatedAt: 1 });

		const { service, fire } = createFakeFileService();
		const watcher = store.add(new ClaudeCliSessionWatcher(service, new NullLogService()));
		const replaces = collectReplace(watcher);
		await timeout(50);

		// The process exits: its state file is removed.
		await fs.rm(join(stateDir, '1.json'));
		fire([{ resource: URI.file(join(stateDir, '1.json')), type: FileChangeType.DELETED }]);
		await timeout(400);

		assert.deepStrictEqual(replaces, []);
		assert.strictEqual(watcher.isSuperseded('A'), false);
	});

	test('a clear by one of several processes sharing a session id does not supersede the still-live id', async () => {
		await writeState('1.json', { sessionId: 'A', status: 'idle', pid: ALIVE_PID, statusUpdatedAt: 1 });
		await writeState('2.json', { sessionId: 'A', status: 'idle', pid: ALIVE_PID_2, statusUpdatedAt: 1 });

		const { service, fire } = createFakeFileService();
		const watcher = store.add(new ClaudeCliSessionWatcher(service, new NullLogService()));
		const replaces = collectReplace(watcher);
		await timeout(50);

		// One of the two processes clears to B; the other still holds A.
		await writeState('1.json', { sessionId: 'B', status: 'busy', pid: ALIVE_PID, statusUpdatedAt: 2 });
		fire([{ resource: URI.file(join(stateDir, '1.json')), type: FileChangeType.UPDATED }]);
		await timeout(400);

		assert.deepStrictEqual(replaces, []);
		assert.strictEqual(watcher.isSuperseded('A'), false);
	});
});
