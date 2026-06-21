/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IShellLaunchConfig } from '../../../../../platform/terminal/common/terminal.js';
import { ITerminalInstance, ITerminalService, ICreateTerminalOptions } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { SESSION_TERMINAL_OWNER, SessionTerminalService, getNativeTerminalLaunch } from '../../browser/sessionTerminalService.js';
import { IActiveSession, ISessionsManagementService } from '../../../sessions/common/sessionsManagement.js';
import { IChat, ISessionWorkspace, SessionStatus } from '../../../sessions/common/session.js';

function fakeInstance(store: Pick<DisposableStore, 'add'>, instanceId: number, reconnectionProperties?: { ownerId: string; data?: unknown }): ITerminalInstance {
	const onDisposed = store.add(new Emitter<ITerminalInstance>());
	const onExit = store.add(new Emitter<number | undefined>());
	const instanceStore = store.add(new DisposableStore());
	return new class extends mock<ITerminalInstance>() {
		override readonly instanceId = instanceId;
		override readonly isDisposed = false;
		override readonly store = instanceStore;
		override readonly reconnectionProperties = reconnectionProperties;
		override readonly onDisposed = onDisposed.event;
		override readonly onExit = onExit.event as Event<number | undefined>;
	};
}

function stubChat(status: SessionStatus): IChat {
	return {
		resource: URI.parse('agent-host-claude:/abc123'),
		createdAt: new Date(),
		title: constObservable('Chat'),
		updatedAt: constObservable(new Date()),
		status: constObservable(status),
		changes: constObservable([]),
		checkpoints: constObservable(undefined),
		modelId: constObservable(undefined),
		mode: constObservable(undefined),
		isArchived: constObservable(false),
		isRead: constObservable(true),
		description: constObservable(undefined),
		lastTurnEnd: constObservable(undefined),
	};
}

function stubSession(options: { sessionId?: string; scheme?: string; rawId?: string; cwd?: URI; status?: SessionStatus }): IActiveSession {
	const scheme = options.scheme ?? 'agent-host-claude';
	const rawId = options.rawId ?? 'abc123';
	const status = options.status ?? SessionStatus.Completed;
	const resource = URI.from({ scheme, path: `/${rawId}` });
	const cwd = options.cwd ?? URI.file('/work/repo');
	const workspace: ISessionWorkspace = {
		uri: cwd,
		label: 'repo',
		icon: Codicon.folder,
		folders: [{ root: cwd, workingDirectory: cwd, name: 'repo', description: undefined }],
		requiresWorkspaceTrust: false,
		isVirtualWorkspace: false,
	};
	const chat = stubChat(status);
	return {
		sessionId: options.sessionId ?? `local:${resource.toString()}`,
		providerId: 'local',
		resource,
		sessionType: 'claude',
		icon: Codicon.vm,
		createdAt: new Date(),
		workspace: constObservable(workspace),
		title: constObservable('Session'),
		updatedAt: constObservable(new Date()),
		status: constObservable(status),
		changesets: constObservable([]),
		changes: constObservable([]),
		modelId: constObservable(undefined),
		mode: constObservable(undefined),
		loading: constObservable(false),
		isArchived: constObservable(false),
		isRead: constObservable(true),
		description: constObservable(undefined),
		lastTurnEnd: constObservable(undefined),
		chats: constObservable([chat]),
		mainChat: constObservable(chat),
		activeChat: constObservable(chat),
		isCreated: constObservable(true),
		sticky: constObservable(false),
		capabilities: { supportsMultipleChats: false },
	};
}

suite('SessionTerminalService', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	interface ITestHarness {
		readonly service: SessionTerminalService;
		readonly createdConfigs: IShellLaunchConfig[];
		readonly disposedIds: number[];
		readonly onDidCreateInstance: Emitter<ITerminalInstance>;
		readonly onDidChangeSessions: Emitter<{ added: readonly IActiveSession[]; removed: readonly IActiveSession[]; changed: readonly IActiveSession[] }>;
		readonly onDidReplaceSession: Emitter<{ from: IActiveSession; to: IActiveSession }>;
		instances: ITerminalInstance[];
	}

	function createHarness(executablePath?: string): ITestHarness {
		const createdConfigs: IShellLaunchConfig[] = [];
		const disposedIds: number[] = [];
		const onDidCreateInstance = disposables.add(new Emitter<ITerminalInstance>());
		const onDidChangeSessions = disposables.add(new Emitter<{ added: readonly IActiveSession[]; removed: readonly IActiveSession[]; changed: readonly IActiveSession[] }>());
		const onDidReplaceSession = disposables.add(new Emitter<{ from: IActiveSession; to: IActiveSession }>());
		const harness: ITestHarness = { instances: [] } as unknown as ITestHarness;
		let nextId = 1;

		const terminalService = new class extends mock<ITerminalService>() {
			override get instances() { return harness.instances; }
			override readonly onDidCreateInstance = onDidCreateInstance.event;
			override async createTerminal(options?: ICreateTerminalOptions): Promise<ITerminalInstance> {
				const config = options!.config as IShellLaunchConfig;
				createdConfigs.push(config);
				const instance = fakeInstance(disposables, nextId++, config.reconnectionProperties);
				harness.instances.push(instance);
				return instance;
			}
			override async safeDisposeTerminal(instance: ITerminalInstance): Promise<void> {
				disposedIds.push(instance.instanceId);
			}
		};

		const sessionsManagementService = new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = onDidChangeSessions.event as Event<never>;
			override readonly onDidReplaceSession = onDidReplaceSession.event as Event<never>;
		};

		const configurationService = new TestConfigurationService(
			executablePath !== undefined ? { chat: { agentHost: { claudeAgent: { executablePath } } } } : {}
		);

		const service = disposables.add(new SessionTerminalService(
			terminalService as unknown as ITerminalService,
			sessionsManagementService as unknown as ISessionsManagementService,
			configurationService as unknown as IConfigurationService,
			new TestNotificationService() as unknown as INotificationService,
			new NullLogService(),
		));

		return Object.assign(harness, { service, createdConfigs, disposedIds, onDidCreateInstance, onDidChangeSessions, onDidReplaceSession });
	}

	test('eligibility: only local agent-host-claude sessions with a file cwd qualify', () => {
		assert.ok(getNativeTerminalLaunch(stubSession({})), 'local claude session qualifies');
		assert.strictEqual(getNativeTerminalLaunch(stubSession({ scheme: 'agent-host-copilotcli' })), undefined, 'non-claude scheme excluded');
		assert.strictEqual(getNativeTerminalLaunch(stubSession({ cwd: URI.parse('vscode-remote://host/work') })), undefined, 'remote cwd excluded');

		// Created session resumes its conversation.
		const created = getNativeTerminalLaunch(stubSession({ rawId: 'native-id-9' }));
		assert.strictEqual(created?.resumeSessionId, 'native-id-9');
		assert.strictEqual(created?.cwd.fsPath, URI.file('/work/repo').fsPath);

		// Uncreated (untitled) session launches a fresh claude (no resume id).
		const fresh = getNativeTerminalLaunch(stubSession({ rawId: 'native-id-9', status: SessionStatus.Untitled }));
		assert.strictEqual(fresh?.resumeSessionId, undefined);
		assert.strictEqual(fresh?.cwd.fsPath, URI.file('/work/repo').fsPath);
	});

	test('getOrCreateTerminal builds the claude --resume launch config and reuses the instance', async () => {
		const h = createHarness('/usr/bin/claude');
		const session = stubSession({ rawId: 'native-id-1', sessionId: 'session-1' });

		const first = await h.service.getOrCreateTerminal(session);
		assert.ok(first, 'creates a terminal');
		assert.strictEqual(h.createdConfigs.length, 1);

		const config = h.createdConfigs[0];
		assert.deepStrictEqual({
			executable: config.executable,
			args: config.args,
			cwd: (config.cwd as URI).fsPath,
			hideFromUser: config.hideFromUser,
			isFeatureTerminal: config.isFeatureTerminal,
			forcePersist: config.forcePersist,
			icon: config.icon,
			ownerId: config.reconnectionProperties?.ownerId,
			data: config.reconnectionProperties?.data,
		}, {
			executable: '/usr/bin/claude',
			args: ['--resume', 'native-id-1'],
			cwd: URI.file('/work/repo').fsPath,
			hideFromUser: true,
			isFeatureTerminal: true,
			forcePersist: true,
			icon: Codicon.terminal,
			ownerId: SESSION_TERMINAL_OWNER,
			data: { sessionId: 'session-1', resumeSessionId: 'native-id-1' },
		});

		const second = await h.service.getOrCreateTerminal(session);
		assert.strictEqual(second, first, 'reuses the same instance');
		assert.strictEqual(h.createdConfigs.length, 1, 'no second terminal created');
	});

	test('getOrCreateTerminal launches a fresh claude (no --resume) for an uncreated session', async () => {
		const h = createHarness();
		const session = stubSession({ rawId: 'untitled-uuid', sessionId: 'session-new', status: SessionStatus.Untitled });

		const instance = await h.service.getOrCreateTerminal(session);
		assert.ok(instance, 'creates a terminal');
		assert.deepStrictEqual(h.createdConfigs[0].args, []);
	});

	test('openNewSessionTerminal marks the session and seeds claude with the submitted prompt', async () => {
		const h = createHarness();
		const session = stubSession({ sessionId: 'session-new', status: SessionStatus.Untitled });

		h.service.openNewSessionTerminal(session, '  build me a website  ');
		assert.ok(h.service.terminalSessionIds.get().has('session-new'), 'session marked for terminal');

		await h.service.getOrCreateTerminal(session);
		assert.deepStrictEqual(h.createdConfigs[0].args, ['build me a website'], 'prompt trimmed and passed as claude arg');

		// Disposing clears the marker and prompt.
		h.service.disposeTerminal('session-new');
		assert.strictEqual(h.service.terminalSessionIds.get().has('session-new'), false);
	});

	test('getOrCreateTerminal returns undefined for ineligible sessions', async () => {
		const h = createHarness();
		assert.strictEqual(await h.service.getOrCreateTerminal(stubSession({ scheme: 'agent-host-copilotcli' })), undefined);
		assert.strictEqual(h.createdConfigs.length, 0);
	});

	test('removed session kills its terminal', async () => {
		const h = createHarness();
		const session = stubSession({ sessionId: 'session-x', rawId: 'r1' });
		const instance = await h.service.getOrCreateTerminal(session);

		h.onDidChangeSessions.fire({ added: [], removed: [session], changed: [] });

		assert.deepStrictEqual(h.disposedIds, [instance!.instanceId]);
		assert.strictEqual(h.service.getTerminal('session-x'), undefined);
	});

	test('revived terminals are re-associated to their session without creating a new one', async () => {
		const h = createHarness();
		const revived = fakeInstance(disposables, 99, { ownerId: SESSION_TERMINAL_OWNER, data: { sessionId: 'session-revived', nativeSessionId: 'r99' } });
		h.instances.push(revived);

		// Arrives asynchronously during reconnection.
		h.onDidCreateInstance.fire(revived);

		assert.strictEqual(h.service.getTerminal('session-revived'), revived);
		assert.strictEqual(h.createdConfigs.length, 0, 'no new terminal created for a revived one');
	});
});
