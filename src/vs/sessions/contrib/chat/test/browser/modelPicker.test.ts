/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentSessionProviders } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentSessions.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsProvider, ISessionModelPickerOptions } from '../../../../services/sessions/common/sessionsProvider.js';
import { ISession, ISessionWorkspace, SessionStatus } from '../../../../services/sessions/common/session.js';
import { sessionHasNoSelectableModel } from '../../browser/modelPicker.js';

const DEFAULT_OPTIONS: ISessionModelPickerOptions = {
	useGroupedModelPicker: true,
	showFeatured: true,
	showUnavailableFeatured: false,
	showManageModelsAction: false,
};

function createSession(providerId: string): ISession {
	// A non-Claude resource scheme so `getNativeTerminalLaunch` (consulted by
	// `sessionHasNoSelectableModel`) returns `undefined` and the regular
	// model-gate logic applies.
	return { providerId, sessionId: `${providerId}:/session`, resource: URI.from({ scheme: providerId, path: '/session' }) } as ISession;
}

/**
 * A terminal-bound local Claude session: `agent-host-claude` scheme with a
 * local file working directory, so {@link getNativeTerminalLaunch} qualifies it
 * for the embedded `claude` terminal (which owns model selection).
 */
function createClaudeTerminalSession(): ISession {
	const cwd = URI.file('/workspace');
	const workspace = { folders: [{ root: cwd, workingDirectory: cwd, name: 'workspace', description: undefined }] } as ISessionWorkspace;
	return {
		providerId: 'claude',
		sessionId: 'agent-host-claude:/abc',
		resource: URI.from({ scheme: AgentSessionProviders.AgentHostClaude, path: '/abc' }),
		workspace: constObservable(workspace),
		status: constObservable(SessionStatus.Untitled),
	} as unknown as ISession;
}

/**
 * Minimal {@link ISessionsProvidersService} stub exposing a single provider
 * whose `getModels` / `getModelPickerOptions` return the supplied values.
 */
function createProvidersService(providerId: string, opts: {
	models: readonly ILanguageModelChatMetadataAndIdentifier[];
	showAutoModel?: boolean;
}): ISessionsProvidersService {
	const provider = {
		id: providerId,
		getModels: () => opts.models,
		getModelPickerOptions: (): ISessionModelPickerOptions => ({ ...DEFAULT_OPTIONS, showAutoModel: opts.showAutoModel }),
	} as unknown as ISessionsProvider;
	return {
		getProvider: (id: string) => (id === providerId ? provider : undefined),
	} as unknown as ISessionsProvidersService;
}

const aModel = { identifier: 'copilot-gpt-4o', metadata: {} } as ILanguageModelChatMetadataAndIdentifier;

suite('sessionHasNoSelectableModel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns false when there is no session', () => {
		const service = createProvidersService('p', { models: [] });
		assert.strictEqual(sessionHasNoSelectableModel(undefined, service), false);
	});

	test('returns false when models are available', () => {
		const service = createProvidersService('p', { models: [aModel], showAutoModel: false });
		assert.strictEqual(sessionHasNoSelectableModel(createSession('p'), service), false);
	});

	test('returns true when empty and Auto is unavailable', () => {
		const service = createProvidersService('p', { models: [], showAutoModel: false });
		assert.strictEqual(sessionHasNoSelectableModel(createSession('p'), service), true);
	});

	test('returns false when empty but Auto is available (fallback)', () => {
		const service = createProvidersService('p', { models: [], showAutoModel: true });
		assert.strictEqual(sessionHasNoSelectableModel(createSession('p'), service), false);
	});

	test('returns false for terminal-bound Claude even when empty and Auto is unavailable', () => {
		// Local Claude runs terminal-only; the native CLI owns model selection, so
		// a missing model must never block sending.
		const service = createProvidersService('claude', { models: [], showAutoModel: false });
		assert.strictEqual(sessionHasNoSelectableModel(createClaudeTerminalSession(), service), false);
	});
});
