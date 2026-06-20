/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { IMarkdownString, MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IMarkdownRenderer } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { ChatContentMarkdownRenderer } from '../../../../../workbench/contrib/chat/browser/widget/chatContentMarkdownRenderer.js';
import { DiffEditorPool, EditorPool } from '../../../../../workbench/contrib/chat/browser/widget/chatContentParts/chatContentCodePools.js';
import { IMarkdownDiffBlockData, MarkdownDiffBlockPart, parseUnifiedDiff } from '../../../../../workbench/contrib/chat/browser/widget/chatContentParts/chatDiffBlockPart.js';
import { codeblockHasClosingBackticks } from '../../../../../workbench/contrib/chat/browser/widget/chatContentParts/chatMarkdownContentPart.js';
import { CodeBlockPart, ICodeBlockData } from '../../../../../workbench/contrib/chat/browser/widget/chatContentParts/codeBlockPart.js';
import { IChatRendererDelegate } from '../../../../../workbench/contrib/chat/browser/widget/chatListRenderer.js';
import { ChatEditorOptions } from '../../../../../workbench/contrib/chat/browser/widget/chatOptions.js';
import { IChatMarkdownContent, IChatThinkingPart, IChatToolInvocation, IChatToolInvocationSerialized } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ChatModeKind } from '../../../../../workbench/contrib/chat/common/constants.js';
import { IChatRendererContent, IChatRequestViewModel, IChatResponseViewModel, isRequestVM } from '../../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { annotateSpecialMarkdownContent, extractCodeblockUrisFromText } from '../../../../../workbench/contrib/chat/common/widget/annotations.js';
import { activeSessionViewForeground, agentsPanelBackground, inactiveSessionViewBackground } from '../../../../common/theme.js';
import { getToolInput, getToolOutput, getToolStatus, getToolStatusIcon } from './claudeToolInvocation.js';

/** Mutable counter threaded through a single response render so code-block ids stay stable. */
interface ICodeBlockCounter {
	value: number;
}

/**
 * Turns chat view-model items into Claude-styled DOM. Owns the Monaco-backed
 * {@link EditorPool}/{@link DiffEditorPool} used for code blocks and diffs (the
 * only pieces reused from the upstream chat widget); markdown prose, thinking
 * blocks, and tool cards are hand-built to match the Claude Code extension.
 *
 * The renderer is stateless across turns: callers own a {@link DisposableStore}
 * per turn and pass it to {@link renderTurn}, disposing it to tear the turn down.
 */
export class ClaudeTranscriptRenderer extends Disposable {

	private readonly _scopedContextKeyService: IContextKeyService;
	private readonly _scopedInstaService: IInstantiationService;
	private readonly _markdownRenderer: IMarkdownRenderer;
	private readonly _editorPool: EditorPool;
	private readonly _diffEditorPool: DiffEditorPool;

	/** Live transcript width, fed to Monaco editors so they size correctly. */
	private _currentWidth = 0;

	constructor(
		container: HTMLElement,
		getListLength: () => number,
		private readonly _onAsyncRender: () => void,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		this._scopedContextKeyService = this._register(contextKeyService.createScoped(container));
		this._scopedInstaService = this._register(instantiationService.createChild(
			new ServiceCollection([IContextKeyService, this._scopedContextKeyService])
		));

		this._markdownRenderer = this._scopedInstaService.createInstance(ChatContentMarkdownRenderer);

		const editorOptions = this._register(this._scopedInstaService.createInstance(
			ChatEditorOptions,
			undefined,
			activeSessionViewForeground,
			inactiveSessionViewBackground,
			agentsPanelBackground,
		));
		const delegate: IChatRendererDelegate = {
			container,
			getListLength,
			currentChatMode: () => ChatModeKind.Agent,
		};
		this._editorPool = this._register(this._scopedInstaService.createInstance(EditorPool, editorOptions, delegate, undefined, true));
		this._diffEditorPool = this._register(this._scopedInstaService.createInstance(DiffEditorPool, editorOptions, delegate, undefined, true));
	}

	/** Update the available width and re-lay-out any code/diff editors in use. */
	layout(width: number): void {
		this._currentWidth = width;
		for (const editor of this._editorPool.inUse()) {
			editor.layout(width);
		}
		for (const editor of this._diffEditorPool.inUse()) {
			editor.layout(width);
		}
	}

	/** Render a single request/response turn into a detached DOM node. */
	renderTurn(item: IChatRequestViewModel | IChatResponseViewModel, store: DisposableStore): HTMLElement {
		return isRequestVM(item) ? this._renderRequest(item) : this._renderResponse(item, store);
	}

	private _renderRequest(request: IChatRequestViewModel): HTMLElement {
		const turn = dom.$('.claude-turn.claude-turn-user');
		const content = turn.appendChild(dom.$('.claude-content'));
		content.textContent = request.messageText;
		return turn;
	}

	private _renderResponse(response: IChatResponseViewModel, store: DisposableStore): HTMLElement {
		const turn = dom.$('.claude-turn.claude-turn-assistant');
		const counter: ICodeBlockCounter = { value: 0 };

		for (const part of annotateSpecialMarkdownContent(response.response.value)) {
			const block = this._renderContentPart(part, response, store, counter);
			if (block) {
				turn.appendChild(block);
			}
		}
		return turn;
	}

	private _renderContentPart(part: IChatRendererContent, response: IChatResponseViewModel, store: DisposableStore, counter: ICodeBlockCounter): HTMLElement | undefined {
		switch (part.kind) {
			case 'markdownContent':
				return this._buildMarkdown(part, response, store, counter);
			case 'thinking':
				return this._buildThinking(part, response, store);
			case 'toolInvocation':
			case 'toolInvocationSerialized':
				return this._buildToolCard(part, store);
			default:
				// Other content kinds (references, todo, confirmations, …) are
				// rendered by later sessions. Render nothing rather than throw.
				return undefined;
		}
	}

	private _buildMarkdown(md: IChatMarkdownContent, response: IChatResponseViewModel, store: DisposableStore, counter: ICodeBlockCounter): HTMLElement {
		const container = dom.$('.claude-content');
		const rendered = store.add(this._markdownRenderer.render(md.content, {
			fillInIncompleteTokens: !response.isComplete,
			asyncRenderCallback: () => this._onAsyncRender(),
			codeBlockRendererSync: (languageId, text, raw) => this._renderCodeFence(languageId, text, raw, response, store, counter),
		}));
		container.appendChild(rendered.element);
		return container;
	}

	/**
	 * Render a fenced code block from markdown as a Monaco {@link CodeBlockPart}
	 * (or a {@link MarkdownDiffBlockPart} for edit diffs), mirroring the wiring
	 * in `ChatMarkdownContentPart`.
	 */
	private _renderCodeFence(languageId: string, text: string, raw: string | undefined, response: IChatResponseViewModel, store: DisposableStore, counter: ICodeBlockCounter): HTMLElement {
		const isComplete = response.isComplete || !raw || codeblockHasClosingBackticks(raw);
		if (!text && !isComplete) {
			const placeholder = dom.$('div');
			placeholder.style.display = 'none';
			return placeholder;
		}

		// Edit diffs arrive as ```diff:<lang> fenced blocks.
		if (languageId === 'diff' && raw) {
			const match = raw.match(/^```diff:(?<lang>\w+)/);
			if (match?.groups) {
				const uriInfo = extractCodeblockUrisFromText(text);
				const { before, after } = parseUnifiedDiff(uriInfo?.textWithoutResult ?? text);
				const diffData: IMarkdownDiffBlockData = {
					element: response,
					codeBlockIndex: counter.value++,
					languageId: match.groups.lang,
					beforeContent: before,
					afterContent: after,
					codeBlockResource: uriInfo?.uri,
					isReadOnly: true,
				};
				const diffPart = store.add(this._scopedInstaService.createInstance(MarkdownDiffBlockPart, diffData, this._diffEditorPool, this._currentWidth));
				return diffPart.element;
			}
		}

		const index = counter.value++;
		let codeText = text;
		let codemapperUri: URI | undefined;
		const uriInfo = extractCodeblockUrisFromText(codeText);
		if (uriInfo) {
			codemapperUri = uriInfo.uri;
			codeText = uriInfo.textWithoutResult;
		}

		const data: ICodeBlockData = {
			languageId,
			text: codeText,
			codeBlockIndex: index,
			element: response,
			parentContextKeyService: this._scopedContextKeyService,
			codemapperUri,
			chatSessionResource: response.sessionResource,
		};
		const ref = store.add(this._editorPool.get(CodeBlockPart.poolKey(response.id, index)));
		ref.object.render(data, this._currentWidth);
		return ref.object.element;
	}

	private _buildThinking(part: IChatThinkingPart, response: IChatResponseViewModel, store: DisposableStore): HTMLElement | undefined {
		const value = Array.isArray(part.value) ? part.value.join('\n\n') : (part.value ?? '');
		if (!value.trim()) {
			return undefined;
		}

		const block = dom.$('.claude-block.claude-thinking');
		const title = part.generatedTitle?.trim() || localize('claudeThinking', "Thinking");
		const header = this._buildBlockHeader(block, Codicon.lightbulbSparkle, title, store);

		const content = block.appendChild(dom.$('.claude-block-content'));
		const rendered = store.add(this._markdownRenderer.render(new MarkdownString(value)));
		content.appendChild(rendered.element);

		// Thinking is collapsed once the turn is complete, expanded while streaming.
		this._makeCollapsible(header, content, response.isComplete, store);
		return block;
	}

	private _buildToolCard(tool: IChatToolInvocation | IChatToolInvocationSerialized, store: DisposableStore): HTMLElement {
		const block = dom.$('.claude-block.claude-tool');
		const status = getToolStatus(tool);

		const message = status === 'running' ? tool.invocationMessage : (tool.pastTenseMessage ?? tool.invocationMessage);
		const header = this._buildBlockHeader(block, getToolStatusIcon(status), message, store, status === 'running');

		const content = block.appendChild(dom.$('.claude-block-content'));
		let hasBody = false;

		const input = getToolInput(tool);
		if (input) {
			const box = content.appendChild(dom.$('pre.claude-input-json'));
			box.textContent = input;
			hasBody = true;
		}

		const output = getToolOutput(tool);
		if (output) {
			const rendered = store.add(this._markdownRenderer.render(new MarkdownString(output)));
			content.appendChild(rendered.element);
			hasBody = true;
		}

		if (hasBody) {
			this._makeCollapsible(header, content, true, store);
		} else {
			content.remove();
		}
		return block;
	}

	/** Build a `header` row (icon + title) and append it to `block`. */
	private _buildBlockHeader(block: HTMLElement, icon: ThemeIcon, title: string | IMarkdownString, store: DisposableStore, spinning = false): HTMLElement {
		const header = block.appendChild(dom.$('.claude-block-header'));

		const iconEl = header.appendChild(dom.$('span.claude-block-icon'));
		iconEl.className = `claude-block-icon ${ThemeIcon.asClassName(icon)}${spinning ? ' codicon-modifier-spin' : ''}`;

		const titleEl = header.appendChild(dom.$('.claude-block-title'));
		if (typeof title === 'string') {
			titleEl.textContent = title;
		} else {
			const rendered = store.add(this._markdownRenderer.render(title));
			titleEl.appendChild(rendered.element);
		}
		return header;
	}

	/** Wire a header so clicking it toggles the visibility of `content`. */
	private _makeCollapsible(header: HTMLElement, content: HTMLElement, startCollapsed: boolean, store: DisposableStore): void {
		let collapsed = startCollapsed;
		const chevron = header.appendChild(dom.$('span.claude-block-chevron'));

		const apply = () => {
			content.style.display = collapsed ? 'none' : '';
			chevron.className = `claude-block-chevron ${ThemeIcon.asClassName(collapsed ? Codicon.chevronRight : Codicon.chevronDown)}`;
		};
		apply();

		header.classList.add('claude-block-header-clickable');
		store.add(dom.addDisposableListener(header, 'click', () => {
			collapsed = !collapsed;
			apply();
		}));
	}
}
