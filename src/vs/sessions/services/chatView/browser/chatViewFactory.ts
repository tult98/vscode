/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { AbstractChatView, IChatViewOptions } from '../../../browser/parts/chatView.js';

export const IChatViewFactory = createDecorator<IChatViewFactory>('chatViewFactory');

/**
 * Creates {@link AbstractChatView} instances for the {@link SessionsPart}
 * internal grid. The factory lives in the services layer so that core
 * (`sessions/browser/`) can instantiate chat views without depending on the
 * concrete view implementations, which live in `sessions/contrib/chat/`.
 */
export interface IChatViewFactory {

	readonly _serviceBrand: undefined;

	/**
	 * Creates a "new chat" view that lets the user pick a workspace and
	 * start a new chat. This is the view the grid is seeded with on startup.
	 */
	createNewChatView(isNewChatInSession: boolean, options: IChatViewOptions): AbstractChatView;

	/**
	 * Creates a chat view that hosts a chat widget for an active session.
	 */
	createChatView(): AbstractChatView;

	/**
	 * Creates a view that hosts an embedded terminal running the native
	 * `claude` CLI (`claude --resume <id>`) for an active session. Used when
	 * the global "terminal mode" toggle is on.
	 */
	createTerminalView(): AbstractChatView;

	/**
	 * Creates a view that hosts the new Claude-parity native renderer for an
	 * active session. Used when the global "Claude native GUI" toggle is on.
	 * Implements the full Claude Code feature set natively (see
	 * `CLAUDE_CODE_PARITY.md`). Replaces the upstream ChatWidget-based
	 * {@link createChatView} for eligible local Claude sessions.
	 */
	createClaudeNativeView(): AbstractChatView;
}
