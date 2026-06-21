/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService, IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { SessionTerminalModeService } from '../../browser/sessionTerminalMode.js';

suite('SessionTerminalModeService', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function create(storage: IStorageService = disposables.add(new InMemoryStorageService())) {
		const service = disposables.add(new SessionTerminalModeService(storage));
		return { service, storage };
	}

	test('toggle flips the observable and persists', () => {
		const { service, storage } = create();

		assert.strictEqual(service.terminalMode.get(), false);

		service.toggle();

		assert.strictEqual(service.terminalMode.get(), true);
		assert.strictEqual(storage.getBoolean('sessions.terminalMode', StorageScope.APPLICATION), true);

		service.toggle();
		assert.strictEqual(service.terminalMode.get(), false);
	});

	test('restores enabled state from storage', () => {
		const storage = disposables.add(new InMemoryStorageService());
		storage.store('sessions.terminalMode', true, StorageScope.APPLICATION, StorageTarget.USER);

		const { service } = create(storage);

		assert.strictEqual(service.terminalMode.get(), true);
	});
});
