/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/claudeNativeChatView.css';
import { $ } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { AbstractChatView, ChatViewKind } from '../../../browser/parts/chatView.js';
import { IChat } from '../../../services/sessions/common/session.js';
import { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';

/**
 * Session 0 scaffold for the Claude-parity native renderer. The full transcript
 * and input composer will be implemented incrementally in subsequent sessions
 * (see `src/vs/sessions/contrib/chat/CLAUDE_CODE_PARITY.md`). For now this
 * view simply mounts inside the `SessionView` grid and displays a placeholder
 * so the toggle can be wired and exercised end-to-end before the rendering
 * work begins.
 */
export class ClaudeNativeChatView extends AbstractChatView {

	static readonly TYPE = 'sessions.claudeNative';

	override readonly kind: ChatViewKind = 'claudeNative';

	/** Scrollable transcript area — populated by later sessions. */
	private readonly _transcript: HTMLElement;

	/** Placeholder message shown until the transcript is implemented. */
	private readonly _placeholder: HTMLElement;

	constructor() {
		super();

		this.element.classList.add('chat-view-claude-native');

		this._transcript = this.element.appendChild($('.claude-native-transcript'));

		this._placeholder = this._transcript.appendChild($('.claude-native-placeholder'));
		this._placeholder.textContent = localize('claudeNativePlaceholder', "Claude native renderer — transcript coming soon.");
	}

	override setChat(_chat: IChat, _historyKey?: string, _session?: IActiveSession): void {
		// Session 1+ will acquire the chat model and render it here.
	}

	override toJSON(): object {
		return { type: ClaudeNativeChatView.TYPE };
	}

	protected override doLayout(_width: number, _height: number, _top: number, _left: number): void {
		// No child widget to size; the transcript div fills 100% via CSS.
	}

	override focus(): void {
		// Session 2 will focus the input composer here.
		this._transcript.focus();
	}
}
