/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/claudeNativeChatView.css';
import * as dom from '../../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IChatModelReference, IChatService } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ChatAgentLocation } from '../../../../../workbench/contrib/chat/common/constants.js';
import { ChatViewModel, isRequestVM, isResponseVM } from '../../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { AbstractChatView, ChatViewKind } from '../../../../browser/parts/chatView.js';
import { IChat } from '../../../../services/sessions/common/session.js';
import { IActiveSession } from '../../../../services/sessions/common/sessionsManagement.js';
import { ClaudeTranscriptRenderer } from './claudeTranscriptRenderer.js';

/** Per-turn DOM + lifetime, keyed by the view-model item id. */
interface IRenderedTurn {
	readonly dom: HTMLElement;
	readonly store: DisposableStore;
	/** The item's `dataId`, which changes whenever its underlying data changes. */
	dataId: string;
}

/**
 * Claude-parity native chat view. Loads the session's chat model, wraps it in a
 * {@link ChatViewModel}, and renders the conversation as custom DOM modeled on
 * the Claude Code for VS Code extension. This class owns the view lifecycle
 * (model loading, turn reconciliation, scrolling, layout); the actual
 * item-to-DOM rendering lives in {@link ClaudeTranscriptRenderer}.
 *
 * See `src/vs/sessions/contrib/chat/CLAUDE_CODE_PARITY.md` (Session 1).
 */
export class ClaudeNativeChatView extends AbstractChatView {

	static readonly TYPE = 'sessions.claudeNative';

	override readonly kind: ChatViewKind = 'claudeNative';

	/** Scrollable transcript area that hosts the turn rows. */
	private readonly _transcript: HTMLElement;

	/** Empty-state shown when the loaded chat has no turns yet. */
	private readonly _emptyState: HTMLElement;

	private readonly _renderer: ClaudeTranscriptRenderer;

	/** Reference to the loaded chat model; disposing releases the model. */
	private readonly _modelRef = this._register(new MutableDisposable<IChatModelReference>());
	/** Cancels any in-flight model load when a new session is set or the view disposes. */
	private readonly _loadCts = this._register(new MutableDisposable<CancellationTokenSource>());
	/** View model wrapping the loaded chat model. */
	private readonly _viewModel = this._register(new MutableDisposable<ChatViewModel>());
	/** Subscriptions tied to the current view model, cleared on chat switch. */
	private readonly _viewModelListeners = this._register(new DisposableStore());

	/** Tracks the currently loaded chat resource to avoid redundant reloads. */
	private _currentChatResource: URI | undefined;

	/** Rendered turns keyed by view-model item id. */
	private readonly _turns = new Map<string, IRenderedTurn>();

	/** Whether the transcript is pinned to the bottom (auto-scroll on new content). */
	private _pinnedToBottom = true;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatService private readonly chatService: IChatService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.element.classList.add('chat-view-claude-native');

		this._transcript = this.element.appendChild(dom.$('.claude-native-transcript'));
		this._emptyState = this._transcript.appendChild(dom.$('.claude-native-empty'));
		this._emptyState.textContent = localize('claudeNativeEmpty', "No messages yet.");

		this._renderer = this._register(this.instantiationService.createInstance(
			ClaudeTranscriptRenderer,
			this._transcript,
			() => this._viewModel.value?.getItems().length ?? 0,
			() => this._scrollToBottomIfPinned(),
		));

		// Track whether the user has scrolled away from the bottom so streaming
		// content only auto-scrolls when they are already pinned there.
		this._register(dom.addDisposableListener(this._transcript, 'scroll', () => {
			this._pinnedToBottom = this._isAtBottom();
		}));
	}

	override dispose(): void {
		this._loadCts.value?.cancel();
		this._clearTranscript();
		super.dispose();
	}

	override setChat(chat: IChat, _historyKey?: string, _session?: IActiveSession): void {
		const resource = chat.resource;

		// Skip loading if we're already showing this chat.
		if (isEqual(this._currentChatResource, resource)) {
			return;
		}

		const previousChatResource = this._currentChatResource;
		this._currentChatResource = resource;

		// Cancel any in-flight load for the previous chat and start a fresh one.
		this._loadCts.value?.cancel();
		if (previousChatResource) {
			this._clearChat();
		}
		const cts = new CancellationTokenSource();
		this._loadCts.value = cts;
		const token = cts.token;

		const loadPromise = this.chatService.acquireOrLoadSession(resource, ChatAgentLocation.Chat, token, 'ClaudeNativeChatView').then(ref => {
			if (token.isCancellationRequested || !ref || !isEqual(this._currentChatResource, resource)) {
				ref?.dispose();
				return;
			}
			this._modelRef.value = ref;

			const viewModel = this.instantiationService.createInstance(ChatViewModel, ref.object, undefined);
			this._viewModel.value = viewModel;
			this._viewModelListeners.add(viewModel.onDidChange(() => this._onViewModelChange()));

			this._pinnedToBottom = true;
			this._renderAll();
		}, err => {
			if (!token.isCancellationRequested) {
				this.logService.error('[ClaudeNativeChatView] Failed to load chat model', err);
			}
			if (isEqual(this._currentChatResource, resource)) {
				this._currentChatResource = undefined;
			}
		});

		// Surface progress on this leaf while the chat model loads. The short
		// delay avoids flashing the bar for fast (cached) loads.
		this.showProgressWhile(loadPromise, 800);
	}

	private _clearChat(): void {
		this._viewModelListeners.clear();
		this._viewModel.clear();
		this._modelRef.clear();
		this._clearTranscript();
	}

	private _clearTranscript(): void {
		for (const turn of this._turns.values()) {
			turn.store.dispose();
			turn.dom.remove();
		}
		this._turns.clear();
	}

	private _onViewModelChange(): void {
		const wasPinned = this._pinnedToBottom;
		this._renderAll();
		if (wasPinned) {
			this._pinnedToBottom = true;
			this._scrollToBottomIfPinned();
			// Re-pin after Monaco editors finish laying out asynchronously.
			dom.scheduleAtNextAnimationFrame(dom.getWindow(this._transcript), () => this._scrollToBottomIfPinned());
		}
	}

	/**
	 * Reconcile the rendered turns with the view model. Turns whose `dataId` is
	 * unchanged are left in place; new turns are appended, changed turns are
	 * re-rendered in place, and removed turns are disposed.
	 */
	private _renderAll(): void {
		const viewModel = this._viewModel.value;
		if (!viewModel) {
			return;
		}

		const seen = new Set<string>();

		for (const item of viewModel.getItems()) {
			if (!isRequestVM(item) && !isResponseVM(item)) {
				continue; // pending dividers etc. are not rendered in Session 1
			}
			seen.add(item.id);

			const existing = this._turns.get(item.id);
			if (existing && existing.dataId === item.dataId) {
				continue; // unchanged
			}

			const store = new DisposableStore();
			const node = this._renderer.renderTurn(item, store);

			if (existing) {
				existing.store.dispose();
				existing.dom.replaceWith(node);
			} else {
				this._transcript.appendChild(node);
			}
			this._turns.set(item.id, { dom: node, store, dataId: item.dataId });
		}

		for (const [id, turn] of this._turns) {
			if (!seen.has(id)) {
				turn.store.dispose();
				turn.dom.remove();
				this._turns.delete(id);
			}
		}

		this._emptyState.style.display = this._turns.size === 0 ? '' : 'none';
	}

	private _isAtBottom(): boolean {
		const t = this._transcript;
		return t.scrollTop + t.clientHeight >= t.scrollHeight - 8;
	}

	private _scrollToBottomIfPinned(): void {
		if (this._pinnedToBottom) {
			this._transcript.scrollTop = this._transcript.scrollHeight;
		}
	}

	override toJSON(): object {
		return { type: ClaudeNativeChatView.TYPE };
	}

	protected override doLayout(width: number, _height: number, _top: number, _left: number): void {
		this._renderer.layout(width);
		this._scrollToBottomIfPinned();
	}

	override focus(): void {
		this._transcript.focus();
	}
}
