/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/terminalChatView.css';
import { $, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { autorun } from '../../../../base/common/observable.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { localize } from '../../../../nls.js';
import { ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { AbstractChatView, ChatViewKind } from '../../../browser/parts/chatView.js';
import { IChat, SessionStatus } from '../../../services/sessions/common/session.js';
import { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionTerminalService } from '../../../services/chatView/browser/sessionTerminalService.js';

/**
 * A session view that hosts an embedded terminal running the native `claude`
 * CLI (`claude --resume <id>`) for an active session. Used when the global
 * terminal-mode toggle is on. The terminal instances are owned by
 * {@link ISessionTerminalService} (one per session, persisted across reloads);
 * this view only attaches/detaches the active session's terminal into its
 * container — it never disposes the underlying pty.
 */
export class TerminalChatView extends AbstractChatView {

	static readonly TYPE = 'sessions.terminal';

	override readonly kind: ChatViewKind = 'terminal';

	/** Hosts the attached terminal's DOM. */
	private readonly _container: HTMLElement;
	/** Inline message shown when there is no terminal to display (waiting / unavailable / exited). */
	private readonly _messageElement: HTMLElement;

	/** Watches the active session's status to defer terminal creation while a turn is in flight. */
	private readonly _sessionDisposables = this._register(new MutableDisposable<DisposableStore>());

	private _currentInstance: ITerminalInstance | undefined;
	/** The session whose terminal is requested (drives stale-guards across async attaches). */
	private _currentSessionId: string | undefined;
	/** The session whose terminal is currently attached into {@link _container}. */
	private _attachedSessionId: string | undefined;
	/** The session whose terminal is being fetched, to avoid concurrent fetches. */
	private _pendingSessionId: string | undefined;

	private _lastDimension: Dimension | undefined;
	private _isActive = true;

	constructor(
		@ISessionTerminalService private readonly sessionTerminalService: ISessionTerminalService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		this.element.classList.add('chat-view-terminal');
		this._container = this.element.appendChild($('.session-terminal-container'));
		this._messageElement = this.element.appendChild($('.session-terminal-message'));
		this._messageElement.style.display = 'none';
	}

	override setChat(_chat: IChat, _historyKey?: string, session?: IActiveSession): void {
		if (!session || session.sessionId === this._currentSessionId) {
			return;
		}

		this._currentSessionId = session.sessionId;
		this._detachCurrent();

		const store = new DisposableStore();
		this._sessionDisposables.value = store;

		// Defer creating the native terminal until the SDK turn (if any) finishes
		// so the SDK subprocess and the native CLI never write the shared
		// transcript at the same time. When the status leaves `InProgress` the
		// autorun re-runs and attaches the terminal.
		store.add(autorun(reader => {
			const status = session.activeChat.read(reader).status.read(reader);
			if (status === SessionStatus.InProgress) {
				this._showMessage(localize('claudeTerminalWaiting', "Waiting for the current turn to finish before opening the Claude terminal…"));
				return;
			}
			this._ensureTerminalAttached(session);
		}));
	}

	private _ensureTerminalAttached(session: IActiveSession): void {
		const sessionId = session.sessionId;
		if (this._attachedSessionId === sessionId && this._currentInstance && !this._currentInstance.isDisposed) {
			return; // already showing this session's terminal
		}
		if (this._pendingSessionId === sessionId) {
			return; // fetch already in flight
		}
		this._pendingSessionId = sessionId;

		const promise = this.sessionTerminalService.getOrCreateTerminal(session).then(instance => {
			if (this._currentSessionId !== sessionId) {
				return; // switched to a different session while awaiting
			}
			if (!instance) {
				this._showMessage(localize('claudeTerminalUnavailable', "The Claude terminal is unavailable for this session."));
				return;
			}
			this._attachInstance(instance, sessionId, this._sessionDisposables.value);
		}, err => {
			this.logService.error('[TerminalChatView] Failed to create terminal for session', err);
			if (this._currentSessionId === sessionId) {
				this._showMessage(localize('claudeTerminalFailed', "The Claude terminal could not be opened."));
			}
		}).finally(() => {
			if (this._pendingSessionId === sessionId) {
				this._pendingSessionId = undefined;
			}
		});

		// Surface progress on this leaf's own bar while the terminal is created,
		// with a short delay to avoid flashing for instant (reused) terminals.
		this.showProgressWhile(promise, 800);
	}

	private _attachInstance(instance: ITerminalInstance, sessionId: string, store: DisposableStore | undefined): void {
		this._detachCurrent();
		this._clearMessage();

		this._currentInstance = instance;
		this._attachedSessionId = sessionId;
		instance.attachToElement(this._container);
		instance.setVisible(this._isActive);
		if (this._lastDimension) {
			instance.layout(this._lastDimension);
		}
		// Force smooth scrolling regardless of terminal.integrated.smoothScrolling or
		// the physical-wheel detector. TerminalInstance.xterm is set asynchronously,
		// so we use xtermReadyPromise and guard against stale sessions.
		instance.xtermReadyPromise.then(xterm => {
			if (xterm && this._currentInstance === instance) {
				xterm.raw.options.smoothScrollDuration = 125;
			}
		});
		// Re-apply after config changes: _updateSmoothScrolling() in XtermTerminal
		// resets smoothScrollDuration whenever terminal.integrated.smoothScrolling is toggled.
		store?.add(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('terminal.integrated.smoothScrolling') && this._currentInstance === instance && instance.xterm) {
				instance.xterm.raw.options.smoothScrollDuration = 125;
			}
		}));

		// If the pty exits (e.g. the user runs /exit or `claude` was not found),
		// drop it and surface a message in place.
		store?.add(instance.onExit(() => {
			if (this._currentInstance === instance) {
				this._currentInstance = undefined;
				this._attachedSessionId = undefined;
				if (this._currentSessionId === sessionId) {
					this._showMessage(localize('claudeTerminalExited', "The Claude terminal exited. Reload the window to restart it."));
				}
			}
		}));
	}

	private _detachCurrent(): void {
		if (this._currentInstance && !this._currentInstance.isDisposed) {
			this._currentInstance.detachFromElement();
		}
		this._currentInstance = undefined;
		this._attachedSessionId = undefined;
	}

	private _showMessage(message: string): void {
		clearNode(this._messageElement);
		this._messageElement.textContent = message;
		this._messageElement.style.display = '';
		this._container.style.display = 'none';
	}

	private _clearMessage(): void {
		clearNode(this._messageElement);
		this._messageElement.style.display = 'none';
		this._container.style.display = '';
	}

	override toJSON(): object {
		return { type: TerminalChatView.TYPE };
	}

	protected override doLayout(width: number, height: number, _top: number, _left: number): void {
		this._lastDimension = new Dimension(width, height);
		if (this._currentInstance && !this._currentInstance.isDisposed) {
			// Defensively re-attach (mirrors TerminalEditor) so the terminal's DOM
			// is hosted in this leaf before sizing it.
			this._currentInstance.attachToElement(this._container);
			this._currentInstance.layout(this._lastDimension);
			// Re-apply smooth scrolling: _updateSmoothScrolling() in XtermTerminal
			// resets smoothScrollDuration on config changes, so we override it here
			// (doLayout is called on every resize, covering post-config-change resets).
			if (this._currentInstance.xterm) {
				this._currentInstance.xterm.raw.options.smoothScrollDuration = 125;
			}
		}
	}

	override focus(): void {
		this._currentInstance?.focus(true);
	}

	override setActive(active: boolean): void {
		if (this._isActive === active) {
			return;
		}
		this._isActive = active;
		// Keep the pty alive when the leaf is inactive, but stop rendering its xterm.
		this._currentInstance?.setVisible(active);
	}

	override dispose(): void {
		// Detach but do NOT dispose the instance: it is owned by
		// ISessionTerminalService and must outlive this (transient) view so it
		// survives toggling terminal mode off/on and grid-leaf reuse.
		this._detachCurrent();
		super.dispose();
	}
}
