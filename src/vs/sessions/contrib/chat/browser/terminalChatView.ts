/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/terminalChatView.css';
import { $, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { localize } from '../../../../nls.js';
import { ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { AbstractChatView, ChatViewKind } from '../../../browser/parts/chatView.js';
import { IChat } from '../../../services/sessions/common/session.js';
import { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';
import { getNativeTerminalLaunch, ISessionTerminalService } from '../../../services/chatView/browser/sessionTerminalService.js';

/**
 * How long `claude`'s terminal output must stay quiet before we consider its
 * input box ready for the initial prompt. The CLI streams its boot UI (welcome
 * box, MCP/plugin loading, …) right after launch; typing the prompt before that
 * settles drops it into a not-yet-interactive input and the submit is swallowed.
 * Waiting for output to fall quiet adapts to slow boots far better than a fixed
 * delay. See {@link TerminalChatView._sendInitialPrompt}.
 */
const INITIAL_PROMPT_IDLE_PERIOD = 800;

/**
 * Upper bound on how long to wait for {@link INITIAL_PROMPT_IDLE_PERIOD} of quiet
 * before sending the prompt anyway, so a CLI that never goes fully quiet still
 * receives it.
 */
const INITIAL_PROMPT_MAX_WAIT = 10_000;

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
	/** Sessions that have already fallen back to a fresh `claude` after a failed resume (one retry only). */
	private readonly _resumeFellBack = new Set<string>();

	private _lastDimension: Dimension | undefined;
	private _isActive = true;
	private _pendingFocus = false;

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

		// Attach the native terminal immediately. The session is terminal-only:
		// the `claude` CLI hosted by this terminal is the sole writer of the
		// session transcript, so there is no SDK subprocess to race with. The
		// session status reaching `InProgress` now reflects that very CLI's
		// activity (surfaced by the agent host's CLI session watcher), so
		// deferring on it would hide the terminal that is doing the work.
		this._ensureTerminalAttached(session);
	}

	private _ensureTerminalAttached(session: IActiveSession, fresh = false): void {
		const sessionId = session.sessionId;
		if (this._attachedSessionId === sessionId && this._currentInstance && !this._currentInstance.isDisposed) {
			return; // already showing this session's terminal
		}
		if (this._pendingSessionId === sessionId) {
			return; // fetch already in flight
		}
		this._pendingSessionId = sessionId;

		const promise = this.sessionTerminalService.getOrCreateTerminal(session, fresh).then(instance => {
			if (this._currentSessionId !== sessionId) {
				return; // switched to a different session while awaiting
			}
			if (!instance) {
				this._showMessage(localize('claudeTerminalUnavailable', "The Claude terminal is unavailable for this session."));
				return;
			}
			this._attachInstance(instance, session, this._sessionDisposables.value);
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

	private _attachInstance(instance: ITerminalInstance, session: IActiveSession, store: DisposableStore | undefined): void {
		const sessionId = session.sessionId;
		this._detachCurrent();
		this._clearMessage();

		this._currentInstance = instance;
		this._attachedSessionId = sessionId;
		instance.attachToElement(this._container);
		instance.setVisible(this._isActive);
		if (this._pendingFocus) {
			this._pendingFocus = false;
			instance.focus(true);
		}
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

		// Deliver the prompt captured by the composer for a brand-new session by
		// typing it into the `claude` TUI (mirroring a normal message), rather
		// than passing it as a launch arg: the embedded terminal spawns `claude`
		// before its real dimensions are delivered, and an argv prompt does not
		// flush its turn until a later resize/input event. We send only after the
		// terminal is attached, laid out and has produced output (its input box is
		// up). Consuming clears the prompt so it is sent exactly once and never
		// replayed on a terminal revived after a reload.
		const initialPrompt = this.sessionTerminalService.consumeInitialPrompt(sessionId);
		if (initialPrompt) {
			this._sendInitialPrompt(instance, sessionId, initialPrompt, store);
		}

		// If the pty exits (e.g. the user runs /exit or `claude` was not found),
		// drop it and surface a message in place.
		store?.add(instance.onExit(exit => {
			if (this._currentInstance !== instance) {
				return;
			}
			this._currentInstance = undefined;
			this._attachedSessionId = undefined;
			if (this._currentSessionId !== sessionId) {
				return;
			}
			// `claude --resume <id>` exits non-zero when the CLI cannot load the
			// session's transcript (e.g. an empty/zero-turn session). Fall back
			// once to a fresh `claude` in the same cwd so the terminal still
			// opens working. A user-initiated `/exit` returns 0, so it does not
			// trigger this.
			const exitedWithError = typeof exit === 'number' && exit !== 0;
			const wasResume = !!getNativeTerminalLaunch(session)?.resumeSessionId;
			if (exitedWithError && wasResume && !this._resumeFellBack.has(sessionId)) {
				this._resumeFellBack.add(sessionId);
				this.sessionTerminalService.disposeTerminal(sessionId);
				this._ensureTerminalAttached(session, /*fresh*/ true);
				return;
			}
			this._showMessage(localize('claudeTerminalExited', "The Claude terminal exited. Reload the window to restart it."));
		}));
	}

	/**
	 * Waits until the freshly launched `claude` CLI is ready to receive input —
	 * its process is up and it has emitted its first output (welcome box / input
	 * prompt) — then types {@link prompt} and submits it. A fallback timeout
	 * guards against a CLI that produces no early output. Stale-guards against a
	 * session switch while awaiting.
	 */
	private async _sendInitialPrompt(instance: ITerminalInstance, sessionId: string, prompt: string, store: DisposableStore | undefined): Promise<void> {
		try {
			await instance.processReady;
			// Wait for `claude` to finish booting (its output falls quiet) before
			// typing — sending during boot drops the prompt into a not-yet-ready
			// input and the submit is swallowed.
			await this._whenTerminalIdle(instance, store);
			if (this._currentInstance !== instance || this._currentSessionId !== sessionId || instance.isDisposed) {
				return; // switched session or terminal gone while awaiting
			}
			// Type the prompt and submit it (the trailing Enter), exactly as the
			// user would once the input box is interactive.
			await instance.sendText(prompt, /*shouldExecute*/ true);
		} catch (err) {
			this.logService.error('[TerminalChatView] Failed to send initial prompt', err);
		}
	}

	/**
	 * Resolves once {@link instance}'s pty output has stayed quiet for
	 * {@link INITIAL_PROMPT_IDLE_PERIOD}ms (its boot UI finished rendering), or
	 * after {@link INITIAL_PROMPT_MAX_WAIT}ms as a hard cap.
	 */
	private _whenTerminalIdle(instance: ITerminalInstance, store: DisposableStore | undefined): Promise<void> {
		return new Promise<void>(resolve => {
			const disposables = new DisposableStore();
			store?.add(disposables);
			// Resolve on disposal too, so a session switch (which disposes the store)
			// unblocks the awaiter — the caller's stale-guard then skips sending.
			disposables.add(toDisposable(() => resolve()));
			const done = () => disposables.dispose();
			// Reset the quiet timer on every chunk of output; resolve once a full
			// idle period elapses with no further output.
			const quietTimer = disposables.add(new MutableDisposable());
			const armQuietTimer = () => { quietTimer.value = disposableTimeout(done, INITIAL_PROMPT_IDLE_PERIOD); };
			disposables.add(instance.onData(armQuietTimer));
			disposables.add(disposableTimeout(done, INITIAL_PROMPT_MAX_WAIT));
			armQuietTimer();
		});
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
		if (this._currentInstance) {
			this._currentInstance.focus(true);
		} else {
			this._pendingFocus = true;
		}
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
