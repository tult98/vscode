/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { constObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ITerminalInstance } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalChatView } from '../../browser/terminalChatView.js';
import { ISessionTerminalService } from '../../../../services/chatView/browser/sessionTerminalService.js';
import { IActiveSession } from '../../../../services/sessions/common/sessionsManagement.js';
import { IChat, ISessionWorkspace, SessionStatus } from '../../../../services/sessions/common/session.js';

interface IFakeInstance extends ITerminalInstance {
	attachCount: number;
	detachCount: number;
	lastVisible: boolean | undefined;
	focusCount: number;
}

function fakeInstance(store: Pick<DisposableStore, 'add'>, instanceId: number): IFakeInstance {
	const onExit = store.add(new Emitter<number | undefined>());
	return new class extends mock<ITerminalInstance>() {
		override readonly instanceId = instanceId;
		override readonly isDisposed = false;
		override readonly onExit = onExit.event as Event<number | undefined>;
		attachCount = 0;
		detachCount = 0;
		lastVisible: boolean | undefined = undefined;
		focusCount = 0;
		override readonly xtermReadyPromise = Promise.resolve(undefined);
		override attachToElement(): void { this.attachCount++; }
		override detachFromElement(): void { this.detachCount++; }
		override setVisible(visible: boolean): void { this.lastVisible = visible; }
		override layout(): void { }
		override focus(): void { this.focusCount++; }
	} as IFakeInstance;
}

function stubSession(sessionId: string, status: ISettableObservable<SessionStatus>): IActiveSession {
	const resource = URI.parse(`agent-host-claude:/${sessionId}`);
	const cwd = URI.file('/work/repo');
	const workspace: ISessionWorkspace = {
		uri: cwd, label: 'repo', icon: Codicon.folder,
		folders: [{ root: cwd, workingDirectory: cwd, name: 'repo', description: undefined }],
		requiresWorkspaceTrust: false, isVirtualWorkspace: false,
	};
	const chat: IChat = {
		resource, createdAt: new Date(), title: constObservable('Chat'), updatedAt: constObservable(new Date()),
		status, changes: constObservable([]), checkpoints: constObservable(undefined), modelId: constObservable(undefined),
		mode: constObservable(undefined), isArchived: constObservable(false), isRead: constObservable(true),
		description: constObservable(undefined), lastTurnEnd: constObservable(undefined),
	};
	return {
		sessionId, providerId: 'local', resource, sessionType: 'claude', icon: Codicon.vm, createdAt: new Date(),
		workspace: constObservable(workspace), title: constObservable('Session'), updatedAt: constObservable(new Date()),
		status: constObservable(status.get()), changesets: constObservable([]), changes: constObservable([]),
		modelId: constObservable(undefined), mode: constObservable(undefined), loading: constObservable(false),
		isArchived: constObservable(false), isRead: constObservable(true), description: constObservable(undefined),
		lastTurnEnd: constObservable(undefined), chats: constObservable([chat]), mainChat: constObservable(chat),
		activeChat: constObservable(chat), isCreated: constObservable(true), sticky: constObservable(false),
		capabilities: { supportsMultipleChats: false },
	};
}

suite('TerminalChatView', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function create() {
		const created = new Map<string, IFakeInstance>();
		let createCount = 0;
		const sessionTerminalService = new class extends mock<ISessionTerminalService>() {
			override async getOrCreateTerminal(session: IActiveSession): Promise<ITerminalInstance | undefined> {
				createCount++;
				let instance = created.get(session.sessionId);
				if (!instance) {
					instance = fakeInstance(disposables, created.size + 1);
					created.set(session.sessionId, instance);
				}
				return instance;
			}
		};
		const view = disposables.add(new TerminalChatView(sessionTerminalService as unknown as ISessionTerminalService, new NullLogService(), new TestConfigurationService()));
		return { view, created, getCreateCount: () => createCount };
	}

	test('setChat attaches the session terminal', async () => {
		const { view, created } = create();
		const status = observableValue<SessionStatus>('status', SessionStatus.Completed);
		view.setChat({} as IChat, undefined, stubSession('s1', status));
		await timeout(0);

		const instance = created.get('s1')!;
		assert.strictEqual(instance.attachCount, 1);
	});

	test('switching sessions detaches the old terminal and attaches the new', async () => {
		const { view, created } = create();
		view.setChat({} as IChat, undefined, stubSession('s1', observableValue('a', SessionStatus.Completed)));
		await timeout(0);
		view.setChat({} as IChat, undefined, stubSession('s2', observableValue('b', SessionStatus.Completed)));
		await timeout(0);

		assert.strictEqual(created.get('s1')!.detachCount, 1, 'old terminal detached');
		assert.strictEqual(created.get('s2')!.attachCount, 1, 'new terminal attached');
	});

	test('dispose detaches but does not dispose the owned terminal', async () => {
		const { view, created } = create();
		view.setChat({} as IChat, undefined, stubSession('s1', observableValue('a', SessionStatus.Completed)));
		await timeout(0);
		const instance = created.get('s1')!;

		view.dispose();
		assert.strictEqual(instance.detachCount, 1, 'detached on dispose');
	});

	test('setActive forwards visibility to the terminal', async () => {
		const { view, created } = create();
		view.setChat({} as IChat, undefined, stubSession('s1', observableValue('a', SessionStatus.Completed)));
		await timeout(0);

		view.setActive(false);
		assert.strictEqual(created.get('s1')!.lastVisible, false);
	});

	test('an in-flight turn defers terminal creation', async () => {
		const { view, getCreateCount } = create();
		const status = observableValue<SessionStatus>('status', SessionStatus.InProgress);
		view.setChat({} as IChat, undefined, stubSession('s1', status));
		await timeout(0);
		assert.strictEqual(getCreateCount(), 0, 'no terminal created while InProgress');

		// Once the turn finishes, the deferred terminal is created.
		status.set(SessionStatus.Completed, undefined);
		await timeout(0);
		assert.strictEqual(getCreateCount(), 1);
	});
});
