/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { InMemoryStorageService, IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { SessionsTerminalModeEnabledContext } from '../../../../common/contextkeys.js';
import { SessionTerminalModeService } from '../../browser/sessionTerminalMode.js';

suite('SessionTerminalModeService', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function create(storage: IStorageService = disposables.add(new InMemoryStorageService())) {
		const contextKeyService = disposables.add(new MockContextKeyService());
		const service = disposables.add(new SessionTerminalModeService(storage, contextKeyService));
		const contextValue = () => contextKeyService.getContextKeyValue(SessionsTerminalModeEnabledContext.key) as boolean | undefined;
		return { service, storage, contextValue };
	}

	test('toggle flips the observable, context key, and persists', () => {
		const { service, storage, contextValue } = create();

		assert.strictEqual(service.terminalMode.get(), false);
		assert.strictEqual(contextValue(), false);

		service.toggle();

		assert.strictEqual(service.terminalMode.get(), true);
		assert.strictEqual(contextValue(), true);
		assert.strictEqual(storage.getBoolean('sessions.terminalMode', StorageScope.APPLICATION), true);

		service.toggle();
		assert.strictEqual(service.terminalMode.get(), false);
		assert.strictEqual(contextValue(), false);
	});

	test('restores enabled state from storage', () => {
		const storage = disposables.add(new InMemoryStorageService());
		storage.store('sessions.terminalMode', true, StorageScope.APPLICATION, StorageTarget.USER);

		const { service, contextValue } = create(storage);

		assert.strictEqual(service.terminalMode.get(), true);
		assert.strictEqual(contextValue(), true);
	});
});
