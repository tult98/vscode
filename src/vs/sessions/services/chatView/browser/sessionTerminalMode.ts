/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { SessionsTerminalModeEnabledContext } from '../../../common/contextkeys.js';

export const ISessionTerminalModeService = createDecorator<ISessionTerminalModeService>('sessionTerminalModeService');

/**
 * Owns the global "terminal mode" toggle for the Agents Window. When on, every
 * eligible (created, Claude-backed, local) session renders an embedded terminal
 * running the native `claude` CLI instead of the GUI chat. The state is exposed
 * as an {@link IObservable} so the {@link SessionView} autorun re-picks the view
 * kind the instant it flips, and is persisted across window reloads.
 */
export interface ISessionTerminalModeService {

	readonly _serviceBrand: undefined;

	/** Whether terminal mode is currently enabled (global, all sessions). */
	readonly terminalMode: IObservable<boolean>;

	/** Flips the toggle. */
	toggle(): void;

	/** Sets the toggle to a specific value. */
	setEnabled(enabled: boolean): void;
}

export class SessionTerminalModeService extends Disposable implements ISessionTerminalModeService {

	declare readonly _serviceBrand: undefined;

	private static readonly STORAGE_KEY = 'sessions.terminalMode';

	private readonly _terminalMode = observableValue<boolean>(this, false);
	readonly terminalMode: IObservable<boolean> = this._terminalMode;

	private readonly _contextKey: IContextKey<boolean>;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		this._contextKey = SessionsTerminalModeEnabledContext.bindTo(contextKeyService);

		const initial = this.storageService.getBoolean(SessionTerminalModeService.STORAGE_KEY, StorageScope.APPLICATION, false);
		this._terminalMode.set(initial, undefined);
		this._contextKey.set(initial);
	}

	toggle(): void {
		this.setEnabled(!this._terminalMode.get());
	}

	setEnabled(enabled: boolean): void {
		if (this._terminalMode.get() === enabled) {
			return;
		}
		this._terminalMode.set(enabled, undefined);
		this._contextKey.set(enabled);
		this.storageService.store(SessionTerminalModeService.STORAGE_KEY, enabled, StorageScope.APPLICATION, StorageTarget.USER);
	}
}
