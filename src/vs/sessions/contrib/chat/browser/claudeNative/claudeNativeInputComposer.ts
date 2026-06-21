/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/claudeNativeInputComposer.css';
import * as dom from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable, observableValue } from '../../../../../base/common/observable.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IEditorConstructionOptions } from '../../../../../editor/browser/config/editorConfiguration.js';
import { EditorExtensionsRegistry } from '../../../../../editor/browser/editorExtensions.js';
import { CodeEditorWidget, ICodeEditorWidgetOptions } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ContextMenuController } from '../../../../../editor/contrib/contextmenu/browser/contextmenu.js';
import { PlaceholderTextContribution } from '../../../../../editor/contrib/placeholderText/browser/placeholderTextContribution.js';
import { SnippetController2 } from '../../../../../editor/contrib/snippet/browser/snippetController2.js';
import { SuggestController } from '../../../../../editor/contrib/suggest/browser/suggestController.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { getSimpleEditorOptions } from '../../../../../workbench/contrib/codeEditor/browser/simpleEditorOptions.js';
import { isExplicitFileOrImageVariableEntry, toFileVariableEntry } from '../../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { IChatService, ChatSendResult } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ChatAgentLocation } from '../../../../../workbench/contrib/chat/common/constants.js';
import { IChatModel } from '../../../../../workbench/contrib/chat/common/model/chatModel.js';
import { getChatSessionType } from '../../../../../workbench/contrib/chat/common/model/chatUri.js';
import { IActiveSession } from '../../../../services/sessions/common/sessionsManagement.js';
import { AgentHostInputCompletionHandler } from '../agentHostInputCompletions.js';
import { NewChatContextAttachments } from '../newChatContextAttachments.js';

const MIN_EDITOR_HEIGHT = 30;
const MAX_EDITOR_HEIGHT = 180;

/** Monotonic counter making each composer's input model URI unique within the process. */
let composerInputSeq = 0;

// --- Inline SVG icons (Trusted-Types-safe via createElementNS, no innerHTML) ---

const SVG_NS = 'http://www.w3.org/2000/svg';

interface ISvgChild {
	readonly tag: string;
	readonly attrs: Readonly<Record<string, string>>;
}

interface ISvgDef {
	readonly viewBox: string;
	readonly sw?: number;
	readonly linecap?: string;
	readonly linejoin?: string;
	readonly children: readonly ISvgChild[];
}

/**
 * The lucide-style glyphs from the Claude Design mock, expressed as data so they can be
 * materialized with {@link createSvgIcon}. Each path strokes `currentColor`, so the color
 * comes from the host element's CSS `color`.
 */
const ICONS: Readonly<Record<string, ISvgDef>> = {
	add: { viewBox: '0 0 16 16', sw: 1.4, linecap: 'round', children: [{ tag: 'line', attrs: { x1: '8', y1: '3.5', x2: '8', y2: '12.5' } }, { tag: 'line', attrs: { x1: '3.5', y1: '8', x2: '12.5', y2: '8' } }] },
	chevron: { viewBox: '0 0 16 16', sw: 1.6, linecap: 'round', linejoin: 'round', children: [{ tag: 'polyline', attrs: { points: '4,6.5 8,10.5 12,6.5' } }] },
	send: { viewBox: '0 0 16 16', sw: 1.5, linejoin: 'round', children: [{ tag: 'path', attrs: { d: 'M2.5 8 13.5 3.2 9.6 13.2 7.6 9z' } }] },
	stop: { viewBox: '0 0 16 16', children: [{ tag: 'rect', attrs: { x: '4', y: '4', width: '8', height: '8', rx: '1.5', fill: 'currentColor', stroke: 'none' } }] },
	terminal: { viewBox: '0 0 16 16', sw: 1.4, linecap: 'round', linejoin: 'round', children: [{ tag: 'polyline', attrs: { points: '3,5 6,8 3,11' } }, { tag: 'line', attrs: { x1: '8', y1: '11', x2: '12', y2: '11' } }] },
	warning: { viewBox: '0 0 16 16', sw: 1.4, linecap: 'round', children: [{ tag: 'path', attrs: { d: 'M8 2.6 14.4 13.4H1.6Z', 'stroke-linejoin': 'round' } }, { tag: 'line', attrs: { x1: '8', y1: '6.4', x2: '8', y2: '9.4' } }, { tag: 'circle', attrs: { cx: '8', cy: '11.3', r: '.55', fill: 'currentColor', stroke: 'none' } }] },
	folder: { viewBox: '0 0 16 16', sw: 1.3, linejoin: 'round', children: [{ tag: 'path', attrs: { d: 'M1.8 4.3h4l1.2 1.5H14.2v7.4H1.8z' } }] },
	branch: { viewBox: '0 0 16 16', sw: 1.3, children: [{ tag: 'circle', attrs: { cx: '4.5', cy: '4', r: '1.7' } }, { tag: 'circle', attrs: { cx: '4.5', cy: '12', r: '1.7' } }, { tag: 'circle', attrs: { cx: '11.5', cy: '5.5', r: '1.7' } }, { tag: 'path', attrs: { d: 'M4.5 5.7v4.6M4.5 9h3.5a3.5 3.5 0 0 0 3.5-2' } }] },
	file: { viewBox: '0 0 16 16', sw: 1.3, linejoin: 'round', children: [{ tag: 'path', attrs: { d: 'M4 1.8h5l3 3v9.4H4z' } }, { tag: 'path', attrs: { d: 'M9 1.8v3h3' } }] },
	upload: { viewBox: '0 0 16 16', sw: 1.3, linecap: 'round', linejoin: 'round', children: [{ tag: 'path', attrs: { d: 'M8 10.2V3' } }, { tag: 'polyline', attrs: { points: '5,5.8 8,2.8 11,5.8' } }, { tag: 'path', attrs: { d: 'M3 10v2.6h10V10' } }] },
	fileAdd: { viewBox: '0 0 16 16', sw: 1.3, linecap: 'round', linejoin: 'round', children: [{ tag: 'path', attrs: { d: 'M4 2h5l3 3v9H4z' } }, { tag: 'path', attrs: { d: 'M9 2v3h3' } }, { tag: 'path', attrs: { d: 'M6 8.4q1 -0.9 2 0t2 0' } }, { tag: 'line', attrs: { x1: '6', y1: '11', x2: '9.5', y2: '11' } }] },
	globe: { viewBox: '0 0 16 16', sw: 1.3, children: [{ tag: 'circle', attrs: { cx: '8', cy: '8', r: '5.6' } }, { tag: 'ellipse', attrs: { cx: '8', cy: '8', rx: '2.5', ry: '5.6' } }, { tag: 'line', attrs: { x1: '2.5', y1: '8', x2: '13.5', y2: '8' } }] },
	shieldAsk: { viewBox: '0 0 24 24', sw: 1.7, linecap: 'round', linejoin: 'round', children: [{ tag: 'path', attrs: { d: 'M18 11V6a2 2 0 0 0-4 0' } }, { tag: 'path', attrs: { d: 'M14 10V4a2 2 0 0 0-4 0v2' } }, { tag: 'path', attrs: { d: 'M10 10.5V6a2 2 0 0 0-4 0v8' } }, { tag: 'path', attrs: { d: 'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15' } }] },
	code: { viewBox: '0 0 24 24', sw: 2, linecap: 'round', linejoin: 'round', children: [{ tag: 'polyline', attrs: { points: '16,18 22,12 16,6' } }, { tag: 'polyline', attrs: { points: '8,6 2,12 8,18' } }] },
	lightning: { viewBox: '0 0 24 24', sw: 1.6, linecap: 'round', linejoin: 'round', children: [{ tag: 'path', attrs: { d: 'M13 2 3 14h9l-1 8 10-12h-9z' } }] },
	plan: { viewBox: '0 0 24 24', sw: 1.7, linecap: 'round', linejoin: 'round', children: [{ tag: 'path', attrs: { d: 'M15 12h-5' } }, { tag: 'path', attrs: { d: 'M15 8h-5' } }, { tag: 'path', attrs: { d: 'M19 17V5a2 2 0 0 0-2-2H4' } }, { tag: 'path', attrs: { d: 'M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3' } }] },
	bypass: { viewBox: '0 0 24 24', sw: 1.8, linecap: 'round', linejoin: 'round', children: [{ tag: 'circle', attrs: { cx: '18', cy: '5', r: '3' } }, { tag: 'circle', attrs: { cx: '6', cy: '12', r: '3' } }, { tag: 'circle', attrs: { cx: '18', cy: '19', r: '3' } }, { tag: 'line', attrs: { x1: '8.6', y1: '10.7', x2: '15.4', y2: '6.3' } }, { tag: 'line', attrs: { x1: '8.6', y1: '13.3', x2: '15.4', y2: '17.7' } }] },
};

function createSvgIcon(targetDocument: Document, name: string, sizePx: number, className?: string): SVGElement {
	const def = ICONS[name];
	const svg = targetDocument.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('width', String(sizePx));
	svg.setAttribute('height', String(sizePx));
	svg.setAttribute('viewBox', def.viewBox);
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('focusable', 'false');
	svg.setAttribute('aria-hidden', 'true');
	if (def.sw !== undefined) { svg.setAttribute('stroke-width', String(def.sw)); }
	if (def.linecap) { svg.setAttribute('stroke-linecap', def.linecap); }
	if (def.linejoin) { svg.setAttribute('stroke-linejoin', def.linejoin); }
	if (className) { svg.setAttribute('class', className); }
	for (const child of def.children) {
		const el = targetDocument.createElementNS(SVG_NS, child.tag);
		for (const key in child.attrs) {
			el.setAttribute(key, child.attrs[key]);
		}
		svg.appendChild(el);
	}
	return svg;
}

// --- Picker option data (placeholder; real selection is wired to services in a follow-up) ---

interface IModelOption {
	readonly label: string;
	readonly note: string;
}

const MODEL_OPTIONS: readonly IModelOption[] = [
	{ label: 'Opus 4.8', note: localize('claudeNativeComposer.model.opus', "1M context") },
	{ label: 'Sonnet 4.8', note: localize('claudeNativeComposer.model.sonnet', "Balanced") },
	{ label: 'Haiku 4.5', note: localize('claudeNativeComposer.model.haiku', "Fastest") },
];

const EFFORT_LEVELS: readonly string[] = [
	localize('claudeNativeComposer.effort.off', "Off"),
	localize('claudeNativeComposer.effort.low', "Low"),
	localize('claudeNativeComposer.effort.medium', "Medium"),
	localize('claudeNativeComposer.effort.high', "High"),
	localize('claudeNativeComposer.effort.max', "Max"),
];
const DEFAULT_EFFORT_INDEX = 3; // "High"

interface IPermissionMode {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly icon: string;
}

const PERMISSION_MODES: readonly IPermissionMode[] = [
	{ id: 'ask', icon: 'shieldAsk', label: localize('claudeNativeComposer.mode.ask', "Ask before edits"), description: localize('claudeNativeComposer.mode.ask.desc', "Claude will ask for approval before making each edit") },
	{ id: 'autoEdit', icon: 'code', label: localize('claudeNativeComposer.mode.autoEdit', "Edit automatically"), description: localize('claudeNativeComposer.mode.autoEdit.desc', "Claude will edit your selected text or the whole file") },
	{ id: 'plan', icon: 'plan', label: localize('claudeNativeComposer.mode.plan', "Plan mode"), description: localize('claudeNativeComposer.mode.plan.desc', "Claude will explore the code and present a plan before editing") },
	{ id: 'auto', icon: 'lightning', label: localize('claudeNativeComposer.mode.auto', "Auto mode"), description: localize('claudeNativeComposer.mode.auto.desc', "Claude will automatically choose the best permission mode for each task") },
	{ id: 'bypass', icon: 'bypass', label: localize('claudeNativeComposer.mode.bypass', "Bypass permissions"), description: localize('claudeNativeComposer.mode.bypass.desc', "Claude will not ask for approval before running potentially dangerous commands") },
];

/** Data backing the status-strip footer. All fields are optional; empty segments are hidden. */
interface IComposerStatus {
	workspaceName?: string;
	branch?: string;
	dirty?: boolean;
	added?: number;
	removed?: number;
	currentFile?: string;
	contextWindowLabel?: string;
	contextPercent?: number;
}

/**
 * Claude-parity follow-up input composer for the native Agents Window chat view — the
 * "Option A · Status strip footer" design: a rounded card with an optional alert banner, the
 * Monaco input, a controls row (add · model + thinking-effort · permission mode · send), and a
 * quiet status-strip footer (workspace · branch + dirty · diff stat · current file · model &
 * context window · context %).
 *
 * It submits follow-up turns directly through {@link IChatService.sendRequest} and morphs its
 * send affordance into a stop affordance while a request is in flight. It reuses the simple
 * Monaco input editor, {@link NewChatContextAttachments} (chips / drag-drop / paste / picker)
 * and {@link AgentHostInputCompletionHandler} (`/` + `@` completions forwarded to the agent
 * host's Claude CLI). The model, thinking-effort and permission-mode dropdowns are custom
 * popups matching the mock; their selections are local UI state for now (real wiring to the
 * model / permission services is a follow-up), and the status-strip data is seeded with
 * placeholders updatable via {@link setStatus}.
 *
 * See `src/vs/sessions/contrib/chat/CLAUDE_CODE_PARITY.md` (Session 2).
 */
export class ClaudeNativeInputComposer extends Disposable {

	/** The active session, mirrored into an observable for the pickers / completions. */
	private readonly _session = observableValue<IActiveSession | undefined>('claudeNativeComposerSession', undefined);
	/** The loaded chat model — the send target and source of in-flight state. */
	private readonly _model = observableValue<IChatModel | undefined>('claudeNativeComposerModel', undefined);
	/** Whether the loaded model currently has a request in flight. */
	private readonly _requestInProgress: IObservable<boolean>;

	private _doc!: Document;
	private _composer!: HTMLElement;
	private _editor!: CodeEditorWidget;
	private _editorContainer!: HTMLElement;

	private readonly _contextAttachments: NewChatContextAttachments;
	private _agentHostInputCompletionHandler: AgentHostInputCompletionHandler | undefined;

	private _sendEl: HTMLElement | undefined;
	private _sending = false;

	/** "Bash" affordance shown while the input starts with `!` (sent to the CLI verbatim). */
	private _bashHint: HTMLElement | undefined;

	// Alert banner.
	private _alertEl: HTMLElement | undefined;
	private _alertMessageEl: HTMLElement | undefined;
	private _alertActionEl: HTMLElement | undefined;
	private readonly _alertActionDisposable = this._register(new MutableDisposable<IDisposable>());

	// Controls-row chips (local selection state, reflected back into the chips).
	private _selectedModel: IModelOption = MODEL_OPTIONS[0];
	private _selectedEffortIndex = DEFAULT_EFFORT_INDEX;
	private _selectedMode: IPermissionMode = PERMISSION_MODES[0];
	private _modelChipLabelEl: HTMLElement | undefined;
	private _modelChipBadgeEl: HTMLElement | undefined;
	private _modeChipEl: HTMLElement | undefined;

	// At most one dropdown menu is open; this holds its popup + outside-click catcher.
	private _openMenuId: string | undefined;
	private readonly _openMenu = this._register(new MutableDisposable<DisposableStore>());

	// Status-strip footer.
	private _statusEl: HTMLElement | undefined;
	private readonly _statusHovers = this._register(new DisposableStore());
	/**
	 * Placeholder values mirroring the design mock so the strip is visible during the UI pass.
	 * Replace via {@link setStatus} once real git / diff / context sources are wired.
	 */
	private _status: IComposerStatus = {
		workspaceName: 'vscode',
		branch: 'claude-native-transcript-session1',
		dirty: true,
		added: 130,
		removed: 10,
		currentFile: 'claudeNativeInputComposer.ts',
		contextWindowLabel: MODEL_OPTIONS[0].note,
		contextPercent: 28,
	};

	constructor(
		private readonly options: {
			/** Resolves the workspace folder used to scope the context picker. */
			getContextFolderUri: () => URI | undefined;
		},
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IModelService private readonly modelService: IModelService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IHoverService private readonly hoverService: IHoverService,
		@IChatService private readonly chatService: IChatService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._requestInProgress = derived(reader => this._model.read(reader)?.requestInProgress.read(reader) ?? false);

		this._contextAttachments = this._register(this.instantiationService.createInstance(NewChatContextAttachments));
		this._register(this._contextAttachments.onDidChangeContext(() => {
			this._updateSendButtonState();
			this.focus();
		}));
	}

	/**
	 * Point the composer at a loaded chat model (and its owning session). Passing
	 * `undefined` detaches it while no chat is shown.
	 */
	setModel(model: IChatModel | undefined, session: IActiveSession | undefined): void {
		this._model.set(model, undefined);
		this._session.set(session, undefined);
		this._updateSendButtonState();
	}

	// --- Rendering ---

	render(parent: HTMLElement): void {
		this._doc = parent.ownerDocument;
		const composer = this._composer = dom.append(parent, dom.$('.claude-native-composer'));

		this._createAlertBanner(composer);

		const body = dom.append(composer, dom.$('.claude-native-composer-body'));

		// Attachment chips row (above the editor).
		const attachRow = dom.append(body, dom.$('.claude-native-composer-attachments'));
		this._contextAttachments.renderAttachedContext(attachRow);
		this._contextAttachments.registerDropTarget(composer);
		this._contextAttachments.registerPasteHandler(composer);

		const inputArea = dom.append(body, dom.$('.claude-native-composer-input'));
		const overflow = dom.append(parent, dom.$('.claude-native-composer-overflow.monaco-editor'));
		overflow.classList.add('hideSuggestTextIcons');
		this._register({ dispose: () => overflow.remove() });
		this._createEditor(inputArea, overflow);
		this._createToolbar(body);

		this._createStatusStrip(composer);

		// Workspace name is the one strip segment we can derive for real today.
		const folder = this.options.getContextFolderUri();
		if (folder) {
			this._status.workspaceName = basename(folder);
		}
		this._renderStatusStrip();

		this._register(autorun(reader => {
			const inProgress = this._requestInProgress.read(reader);
			this._updateSendStopButton(inProgress);
		}));
	}

	private _icon(name: string, sizePx: number, className?: string): SVGElement {
		return createSvgIcon(this._doc, name, sizePx, className);
	}

	/** Wire an element as an activatable button (role, keyboard, hover). */
	private _asButton(el: HTMLElement, ariaLabel: string, onActivate: () => void): void {
		el.role = 'button';
		el.tabIndex = 0;
		el.setAttribute('aria-label', ariaLabel);
		this._register(dom.addDisposableListener(el, dom.EventType.CLICK, () => onActivate()));
		this._register(dom.addDisposableListener(el, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				event.preventDefault();
				event.stopPropagation();
				onActivate();
			}
		}));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), el, ariaLabel));
	}

	private _createEditor(container: HTMLElement, overflowWidgetsDomNode: HTMLElement): void {
		const editorContainer = this._editorContainer = dom.append(container, dom.$('.claude-native-composer-editor'));
		editorContainer.style.height = `${MIN_EDITOR_HEIGHT}px`;

		const inputScopedContextKeyService = this._register(this.contextKeyService.createScoped(container));
		const scopedInstantiationService = this._register(this.instantiationService.createChild(new ServiceCollection([IContextKeyService, inputScopedContextKeyService])));

		const uri = URI.from({ scheme: 'sessions-chat', path: `claude-native-input-${composerInputSeq++}` });
		const textModel = this._register(this.modelService.createModel('', null, uri, true));

		const editorOptions: IEditorConstructionOptions = {
			...getSimpleEditorOptions(this.configurationService),
			readOnly: false,
			ariaLabel: localize('claudeNativeComposer.ariaLabel', "Chat input"),
			placeholder: localize('claudeNativeComposer.placeholder', "Reply to Claude…"),
			fontFamily: 'system-ui, -apple-system, sans-serif',
			fontSize: 13,
			lineHeight: 20,
			cursorWidth: 1,
			padding: { top: 8, bottom: 2 },
			wrappingStrategy: 'advanced',
			stickyScroll: { enabled: false },
			renderWhitespace: 'none',
			overflowWidgetsDomNode,
			suggest: {
				showIcons: true,
				showSnippets: false,
				showWords: true,
				showStatusBar: false,
				insertMode: 'insert',
			},
		};

		const widgetOptions: ICodeEditorWidgetOptions = {
			isSimpleWidget: true,
			contributions: EditorExtensionsRegistry.getSomeEditorContributions([
				ContextMenuController.ID,
				SuggestController.ID,
				SnippetController2.ID,
				PlaceholderTextContribution.ID,
			]),
		};

		this._editor = this._register(scopedInstantiationService.createInstance(CodeEditorWidget, editorContainer, editorOptions, widgetOptions));
		this._editor.setModel(textModel);
		// Render the suggest widget above the input so it is not clipped.
		SuggestController.get(this._editor)?.forceRenderingAbove();

		this._register(this._editor.onKeyDown(e => {
			if (e.keyCode === KeyCode.Enter && !e.shiftKey && !e.ctrlKey && !e.altKey) {
				// Let the suggest widget accept the completion instead of sending.
				if (this._editor.contextKeyService.getContextKeyValue<boolean>('suggestWidgetVisible')) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				this._send();
			}
			// Cmd/Ctrl+/ — open the context picker (parity with the new-session input).
			if (e.equals(KeyMod.CtrlCmd | KeyCode.Slash)) {
				e.preventDefault();
				e.stopPropagation();
				this._contextAttachments.showPicker(this.options.getContextFolderUri());
			}
		}));

		let previousHeight = -1;
		this._register(this._editor.onDidContentSizeChange(e => {
			if (!e.contentHeightChanged) {
				return;
			}
			const clampedHeight = Math.min(MAX_EDITOR_HEIGHT, Math.max(MIN_EDITOR_HEIGHT, this._editor.getContentHeight()));
			if (clampedHeight === previousHeight) {
				return;
			}
			previousHeight = clampedHeight;
			this._editorContainer.style.height = `${clampedHeight}px`;
			this._editor.layout();
		}));

		this._register(this._editor.onDidChangeModelContent(() => {
			this._updateSendButtonState();
			this._updateBashHint();
		}));

		// `/` + `@` completions resolved against the active session's agent host.
		this._agentHostInputCompletionHandler = this._register(this.instantiationService.createInstance(AgentHostInputCompletionHandler, this._editor, this._contextAttachments));
	}

	// --- Alert banner ---

	private _createAlertBanner(composer: HTMLElement): void {
		const el = this._alertEl = dom.append(composer, dom.$('.claude-native-composer-alert'));
		el.appendChild(this._icon('warning', 14, 'claude-native-composer-alert-icon'));
		this._alertMessageEl = dom.append(el, dom.$('span.claude-native-composer-alert-message'));
		this._alertActionEl = dom.append(el, dom.$('span.claude-native-composer-alert-action'));
		this._alertActionEl.style.display = 'none';
		const close = dom.append(el, dom.$('span.claude-native-composer-alert-close', undefined, '×'));
		this._asButton(close, localize('claudeNativeComposer.dismiss', "Dismiss"), () => this.clearAlert());
	}

	// --- Controls row ---

	private _createToolbar(body: HTMLElement): void {
		const toolbar = dom.append(body, dom.$('.claude-native-composer-toolbar'));

		// Add-context dropdown.
		const addWrap = dom.append(toolbar, dom.$('.claude-native-composer-chip-wrap'));
		const addChip = dom.append(addWrap, dom.$('.claude-native-composer-chip.icon-only'));
		addChip.appendChild(this._icon('add', 16));
		this._asButton(addChip, localize('claudeNativeComposer.addContext', "Add Context..."), () => this._toggleMenu('add', store => this._buildAddMenu(addWrap, store)));

		// Model + thinking-effort dropdown.
		const modelWrap = dom.append(toolbar, dom.$('.claude-native-composer-chip-wrap'));
		const modelChip = dom.append(modelWrap, dom.$('.claude-native-composer-chip'));
		this._modelChipLabelEl = dom.append(modelChip, dom.$('span.claude-native-composer-chip-label'));
		this._modelChipBadgeEl = dom.append(modelChip, dom.$('span.claude-native-composer-chip-badge'));
		modelChip.appendChild(this._icon('chevron', 11, 'claude-native-composer-chip-chevron'));
		this._updateModelChip();
		this._asButton(modelChip, localize('claudeNativeComposer.model', "Model"), () => this._toggleMenu('model', store => this._buildModelMenu(modelWrap, store)));

		// Permission-mode dropdown.
		const modeWrap = dom.append(toolbar, dom.$('.claude-native-composer-chip-wrap'));
		const modeChip = this._modeChipEl = dom.append(modeWrap, dom.$('.claude-native-composer-chip'));
		this._updateModeChip();
		this._asButton(modeChip, localize('claudeNativeComposer.permissionMode', "Permission mode"), () => this._toggleMenu('mode', store => this._buildModeMenu(modeWrap, store)));

		// Bash-mode hint — surfaces while the input starts with `!`. The text is still
		// sent to the CLI verbatim; this is purely an affordance.
		this._bashHint = dom.append(toolbar, dom.$('.claude-native-composer-bash-hint'));
		this._bashHint.appendChild(this._icon('terminal', 14));
		dom.append(this._bashHint, dom.$('span', undefined, localize('claudeNativeComposer.bashMode', "Bash")));
		this._updateBashHint();

		dom.append(toolbar, dom.$('.claude-native-composer-toolbar-spacer'));

		// Send / stop affordance.
		const sendEl = this._sendEl = dom.append(toolbar, dom.$('.claude-native-composer-send'));
		sendEl.role = 'button';
		sendEl.tabIndex = 0;
		this._register(dom.addDisposableListener(sendEl, dom.EventType.CLICK, () => this._onSendClick()));
		this._register(dom.addDisposableListener(sendEl, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				event.preventDefault();
				event.stopPropagation();
				this._onSendClick();
			}
		}));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), sendEl,
			() => this._requestInProgress.get() ? localize('claudeNativeComposer.stop', "Cancel") : localize('claudeNativeComposer.send', "Send")));
		this._updateSendStopButton(this._requestInProgress.get());
	}

	private _onSendClick(): void {
		if (this._requestInProgress.get()) {
			this._cancel();
		} else {
			this._send();
		}
	}

	private _updateModelChip(): void {
		if (this._modelChipLabelEl) {
			this._modelChipLabelEl.textContent = this._selectedModel.label;
		}
		if (this._modelChipBadgeEl) {
			this._modelChipBadgeEl.textContent = EFFORT_LEVELS[this._selectedEffortIndex];
		}
	}

	private _updateModeChip(): void {
		const chip = this._modeChipEl;
		if (!chip) {
			return;
		}
		dom.clearNode(chip);
		chip.classList.toggle('mode-bypass', this._selectedMode.id === 'bypass');
		chip.appendChild(this._icon(this._selectedMode.icon, 15));
		dom.append(chip, dom.$('span.claude-native-composer-chip-label', undefined, this._selectedMode.label));
	}

	// --- Dropdown menus ---

	private _toggleMenu(id: string, build: (store: DisposableStore) => HTMLElement): void {
		if (this._openMenuId === id) {
			this._closeMenu();
			return;
		}
		this._closeMenu();
		this._openMenuId = id;

		const store = new DisposableStore();
		// Outside-click catcher sits below the popup but above everything else.
		const catcher = dom.append(this._composer, dom.$('.claude-native-composer-menu-catcher'));
		store.add(dom.addDisposableListener(catcher, dom.EventType.MOUSE_DOWN, () => this._closeMenu()));
		store.add(toDisposable(() => catcher.remove()));

		const menu = build(store);
		store.add(toDisposable(() => menu.remove()));
		this._openMenu.value = store;
	}

	private _closeMenu(): void {
		this._openMenuId = undefined;
		this._openMenu.clear();
	}

	private _menuItem(menu: HTMLElement, store: DisposableStore, icon: string, label: string, onSelect: () => void): void {
		const row = dom.append(menu, dom.$('.claude-native-composer-menu-item'));
		row.appendChild(this._icon(icon, 16, 'claude-native-composer-menu-item-icon'));
		dom.append(row, dom.$('span', undefined, label));
		store.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => {
			this._closeMenu();
			onSelect();
		}));
	}

	private _buildAddMenu(wrap: HTMLElement, store: DisposableStore): HTMLElement {
		const menu = dom.append(wrap, dom.$('.claude-native-composer-menu'));
		this._menuItem(menu, store, 'upload', localize('claudeNativeComposer.add.upload', "Upload from Computer"), () => this._contextAttachments.showPicker(this.options.getContextFolderUri()));
		this._menuItem(menu, store, 'fileAdd', localize('claudeNativeComposer.add.context', "Add Context..."), () => this._contextAttachments.showPicker(this.options.getContextFolderUri()));
		this._menuItem(menu, store, 'globe', localize('claudeNativeComposer.add.web', "Browse the Web"), () => { /* wired in a follow-up */ });
		return menu;
	}

	private _buildModelMenu(wrap: HTMLElement, store: DisposableStore): HTMLElement {
		const menu = dom.append(wrap, dom.$('.claude-native-composer-menu'));

		dom.append(menu, dom.$('.claude-native-composer-menu-label', undefined, localize('claudeNativeComposer.modelSection', "Model")));
		for (const model of MODEL_OPTIONS) {
			const selected = model.label === this._selectedModel.label;
			const row = dom.append(menu, dom.$('.claude-native-composer-menu-item' + (selected ? '.selected' : '')));
			dom.append(row, dom.$('span', undefined, model.label));
			dom.append(row, dom.$('span.claude-native-composer-menu-item-note', undefined, model.note));
			store.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => {
				this._closeMenu();
				this._selectedModel = model;
				this._updateModelChip();
				this.setStatus({ contextWindowLabel: model.note });
			}));
		}

		dom.append(menu, dom.$('.claude-native-composer-menu-sep'));

		dom.append(menu, dom.$('.claude-native-composer-menu-label', undefined, localize('claudeNativeComposer.effortSection', "Thinking effort")));
		EFFORT_LEVELS.forEach((level, index) => {
			const selected = index === this._selectedEffortIndex;
			const row = dom.append(menu, dom.$('.claude-native-composer-menu-item' + (selected ? '.selected' : '')));
			dom.append(row, dom.$('span', undefined, level));
			if (selected) {
				dom.append(row, dom.$('span.claude-native-composer-menu-item-check', undefined, '✓'));
			}
			store.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => {
				this._closeMenu();
				this._selectedEffortIndex = index;
				this._updateModelChip();
			}));
		});

		return menu;
	}

	private _buildModeMenu(wrap: HTMLElement, store: DisposableStore): HTMLElement {
		const menu = dom.append(wrap, dom.$('.claude-native-composer-menu.mode-menu'));

		const header = dom.append(menu, dom.$('.claude-native-composer-mode-menu-header'));
		dom.append(header, dom.$('span', undefined, localize('claudeNativeComposer.modesHeader', "Modes")));
		const hint = dom.append(header, dom.$('span.claude-native-composer-mode-menu-hint'));
		dom.append(hint, dom.$('span.claude-native-composer-kbd', undefined, '⇧'));
		dom.append(hint, dom.$('span', undefined, '+'));
		dom.append(hint, dom.$('span.claude-native-composer-kbd', undefined, localize('claudeNativeComposer.tab', "tab")));
		dom.append(hint, dom.$('span', undefined, localize('claudeNativeComposer.toSwitch', "to switch")));

		for (const mode of PERMISSION_MODES) {
			const selected = mode.id === this._selectedMode.id;
			const row = dom.append(menu, dom.$('.claude-native-composer-mode-row' + (selected ? '.selected' : '')));
			const iconWrap = dom.append(row, dom.$('.claude-native-composer-mode-row-icon'));
			iconWrap.appendChild(this._icon(mode.icon, 16));
			const rowBody = dom.append(row, dom.$('.claude-native-composer-mode-row-body'));
			const title = dom.append(rowBody, dom.$('.claude-native-composer-mode-row-title'));
			dom.append(title, dom.$('span', undefined, mode.label));
			if (selected) {
				dom.append(title, dom.$('span.claude-native-composer-mode-row-check', undefined, '✓'));
			}
			dom.append(rowBody, dom.$('.claude-native-composer-mode-row-desc', undefined, mode.description));
			store.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => {
				this._closeMenu();
				this._selectedMode = mode;
				this._updateModeChip();
			}));
		}

		return menu;
	}

	// --- Status strip ---

	private _createStatusStrip(composer: HTMLElement): void {
		this._statusEl = dom.append(composer, dom.$('.claude-native-composer-status'));
	}

	private _ringColor(percent: number): string {
		if (percent >= 85) {
			return 'var(--vscode-charts-red)';
		}
		if (percent >= 60) {
			return 'var(--vscode-charts-yellow)';
		}
		return 'var(--vscode-charts-green)';
	}

	private _renderStatusStrip(): void {
		const el = this._statusEl;
		if (!el) {
			return;
		}
		dom.clearNode(el);
		this._statusHovers.clear();
		const s = this._status;

		const groups: HTMLElement[] = [];

		if (s.workspaceName) {
			const g = dom.$('.claude-native-composer-status-group');
			g.appendChild(this._icon('folder', 13, 'claude-native-composer-status-icon'));
			dom.append(g, dom.$('span.claude-native-composer-status-text', undefined, s.workspaceName));
			groups.push(g);
		}

		if (s.branch) {
			const g = dom.$('.claude-native-composer-status-group.bright');
			g.appendChild(this._icon('branch', 13, 'claude-native-composer-status-icon'));
			dom.append(g, dom.$('span.claude-native-composer-status-text', undefined, s.branch));
			// The dirty dot + diff stat form one cluster, set off from the branch name,
			// with the dot sitting immediately before the +/- counts.
			if (s.dirty || s.added !== undefined || s.removed !== undefined) {
				const diff = dom.$('span.claude-native-composer-diff');
				if (s.dirty) {
					const dot = dom.append(diff, dom.$('span.claude-native-composer-dirty-dot'));
					this._statusHovers.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), dot, localize('claudeNativeComposer.uncommitted', "Uncommitted changes")));
				}
				if (s.added !== undefined || s.removed !== undefined) {
					dom.append(diff, dom.$('span.claude-native-composer-diff-added', undefined, `+${s.added ?? 0}`));
					dom.append(diff, dom.$('span.claude-native-composer-diff-removed', undefined, `-${s.removed ?? 0}`));
				}
				g.appendChild(diff);
			}
			groups.push(g);
		}

		if (s.currentFile) {
			const g = dom.$('.claude-native-composer-status-group.bright');
			g.appendChild(this._icon('file', 12, 'claude-native-composer-status-icon'));
			dom.append(g, dom.$('span.claude-native-composer-status-text.claude-native-composer-status-mono', undefined, s.currentFile));
			groups.push(g);
		}

		groups.forEach((g, index) => {
			if (index > 0) {
				dom.append(el, dom.$('span.claude-native-composer-status-divider'));
			}
			el.appendChild(g);
		});

		// Right-aligned context group. The model name lives on the model chip, so the
		// strip carries only the context-window label and usage ring.
		if (s.contextWindowLabel || s.contextPercent !== undefined) {
			const right = dom.append(el, dom.$('.claude-native-composer-status-group.right'));
			if (s.contextWindowLabel) {
				dom.append(right, dom.$('span', undefined, s.contextWindowLabel));
			}
			if (s.contextPercent !== undefined) {
				const percent = Math.max(0, Math.min(100, s.contextPercent));
				const context = dom.append(right, dom.$('.claude-native-composer-context'));
				const ring = dom.append(context, dom.$('.claude-native-composer-context-ring'));
				ring.style.background = `conic-gradient(${this._ringColor(percent)} ${percent}%, var(--vscode-editorWidget-border) 0)`;
				dom.append(context, dom.$('span.claude-native-composer-context-value', undefined, `${Math.round(percent)}%`));
				this._statusHovers.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), context, localize('claudeNativeComposer.contextUsed', "{0}% of context window used", Math.round(percent))));
			}
		}
	}

	// --- Send / Cancel ---

	private async _send(): Promise<void> {
		const model = this._model.get();
		if (!model || this._sending) {
			return;
		}
		// While a request is in flight the button cancels instead of sending.
		if (this._requestInProgress.get()) {
			return;
		}

		const rawQuery = this._editor.getModel()?.getValue() ?? '';
		const query = rawQuery.trim();
		const queryOffset = rawQuery.length - rawQuery.trimStart().length;
		const hasSendableAttachment = this._contextAttachments.attachments.some(isExplicitFileOrImageVariableEntry);
		if (!query && !hasSendableAttachment) {
			return;
		}

		const attachments = this._agentHostInputCompletionHandler?.getAttachmentsForSend(query, queryOffset) ?? [...this._contextAttachments.attachments];
		const attachedContext = attachments.length > 0 ? attachments : undefined;

		// Bind the request to the session's agent-host coding agent (e.g.
		// `agent-host-claude`) the same way `ChatWidget` does via `agentIdSilent`.
		// This UI only ever drives agent-host sessions, so the session type is the
		// agent id; no Copilot/local-chat fallback is needed.
		const agentIdSilent = getChatSessionType(model.sessionResource);

		this._sending = true;
		this._editor.updateOptions({ readOnly: true });
		this._updateSendButtonState();
		try {
			const result = await this.chatService.sendRequest(model.sessionResource, query, {
				location: ChatAgentLocation.Chat,
				agentIdSilent,
				attachedContext,
			});
			if (!ChatSendResult.isRejected(result)) {
				this._contextAttachments.clear();
				this._editor.getModel()?.setValue('');
			}
		} catch (e) {
			this.logService.error('[ClaudeNativeInputComposer] Failed to send request', e);
		} finally {
			this._sending = false;
			this._editor.updateOptions({ readOnly: false });
			this._updateSendButtonState();
		}
	}

	private _cancel(): void {
		const model = this._model.get();
		if (model) {
			this.chatService.cancelCurrentRequestForSession(model.sessionResource, 'claudeNativeComposer').catch(e => this.logService.error('[ClaudeNativeInputComposer] Failed to cancel request', e));
		}
	}

	private _updateSendStopButton(inProgress: boolean): void {
		const el = this._sendEl;
		if (!el) {
			return;
		}
		dom.clearNode(el);
		if (inProgress) {
			el.appendChild(this._icon('stop', 12));
			el.classList.remove('disabled');
			el.setAttribute('aria-label', localize('claudeNativeComposer.stop', "Cancel"));
		} else {
			el.appendChild(this._icon('send', 15));
			el.setAttribute('aria-label', localize('claudeNativeComposer.send', "Send"));
			this._updateSendButtonState();
		}
	}

	private _updateBashHint(): void {
		if (!this._bashHint) {
			return;
		}
		const isBash = (this._editor?.getModel()?.getValue() ?? '').trimStart().startsWith('!');
		this._bashHint.classList.toggle('visible', isBash);
	}

	private _updateSendButtonState(): void {
		const el = this._sendEl;
		if (!el || this._requestInProgress.get()) {
			return;
		}
		const hasText = !!this._editor?.getModel()?.getValue().trim();
		const hasSendableAttachment = this._contextAttachments.attachments.some(isExplicitFileOrImageVariableEntry);
		const enabled = !this._sending && !!this._model.get() && (hasText || hasSendableAttachment);
		el.classList.toggle('disabled', !enabled);
	}

	// --- Host API ---

	/** Update one or more status-strip segments. Empty segments are hidden. */
	setStatus(partial: Partial<IComposerStatus>): void {
		this._status = { ...this._status, ...partial };
		this._renderStatusStrip();
	}

	/** Show the alert banner with an optional action link. */
	showAlert(message: string, actionLabel?: string, onAction?: () => void): void {
		if (!this._alertEl || !this._alertMessageEl || !this._alertActionEl) {
			return;
		}
		this._alertMessageEl.textContent = message;
		this._alertActionDisposable.clear();
		if (actionLabel && onAction) {
			this._alertActionEl.textContent = actionLabel;
			this._alertActionEl.style.display = '';
			this._alertActionDisposable.value = dom.addDisposableListener(this._alertActionEl, dom.EventType.CLICK, () => onAction());
		} else {
			this._alertActionEl.style.display = 'none';
		}
		this._alertEl.classList.add('visible');
	}

	/** Hide the alert banner. */
	clearAlert(): void {
		this._alertEl?.classList.remove('visible');
		this._alertActionDisposable.clear();
	}

	prefill(text: string): void {
		const model = this._editor?.getModel();
		if (this._editor && model) {
			model.setValue(text);
			const lastLine = model.getLineCount();
			this._editor.setPosition({ lineNumber: lastLine, column: model.getLineMaxColumn(lastLine) });
			this._editor.focus();
		}
	}

	sendQuery(text: string): void {
		const model = this._editor?.getModel();
		if (model) {
			model.setValue(text);
			this._send();
		}
	}

	attach(uris: URI[]): void {
		this._contextAttachments.addAttachments(...uris.map(uri => toFileVariableEntry(uri)));
	}

	layout(): void {
		this._editor?.layout();
	}

	focus(): void {
		this._editor?.focus();
	}
}
