/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { SessionsClaudeNativeModeEnabledContext } from '../../../common/contextkeys.js';

export const ISessionClaudeNativeModeService = createDecorator<ISessionClaudeNativeModeService>('sessionClaudeNativeModeService');

/**
 * Owns the global "Claude native GUI" toggle for the Agents Window. When on,
 * every eligible (created, Claude-backed, local) session renders the new
 * Claude-parity native renderer instead of the upstream ChatWidget. The state
 * is exposed as an {@link IObservable} so the {@link SessionView} autorun
 * re-picks the view kind the instant it flips, and is persisted across reloads.
 */
export interface ISessionClaudeNativeModeService {

	readonly _serviceBrand: undefined;

	/** Whether Claude native mode is currently enabled (global, all sessions). */
	readonly claudeNativeMode: IObservable<boolean>;

	/** Flips the toggle. */
	toggle(): void;

	/** Sets the toggle to a specific value. */
	setEnabled(enabled: boolean): void;
}

export class SessionClaudeNativeModeService extends Disposable implements ISessionClaudeNativeModeService {

	declare readonly _serviceBrand: undefined;

	private static readonly STORAGE_KEY = 'sessions.claudeNativeMode';

	private readonly _claudeNativeMode = observableValue<boolean>(this, false);
	readonly claudeNativeMode: IObservable<boolean> = this._claudeNativeMode;

	private readonly _contextKey: IContextKey<boolean>;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		this._contextKey = SessionsClaudeNativeModeEnabledContext.bindTo(contextKeyService);

		const initial = this.storageService.getBoolean(SessionClaudeNativeModeService.STORAGE_KEY, StorageScope.APPLICATION, false);
		this._claudeNativeMode.set(initial, undefined);
		this._contextKey.set(initial);
	}

	toggle(): void {
		this.setEnabled(!this._claudeNativeMode.get());
	}

	setEnabled(enabled: boolean): void {
		if (this._claudeNativeMode.get() === enabled) {
			return;
		}
		this._claudeNativeMode.set(enabled, undefined);
		this._contextKey.set(enabled);
		this.storageService.store(SessionClaudeNativeModeService.STORAGE_KEY, enabled, StorageScope.APPLICATION, StorageTarget.USER);
	}
}
