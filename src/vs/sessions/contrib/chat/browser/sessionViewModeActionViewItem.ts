/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { BaseActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IAction } from '../../../../base/common/actions.js';
import { Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { Menus } from '../../../browser/menus.js';
import { ISessionClaudeNativeModeService } from '../../../services/chatView/browser/sessionClaudeNativeMode.js';
import { ISessionTerminalModeService } from '../../../services/chatView/browser/sessionTerminalMode.js';

/** Command id the segmented view-mode toggle is anchored to in {@link Menus.TitleBarSessionMenu}. */
export const TOGGLE_VIEW_MODE_ACTION_ID = 'agentSession.toggleViewMode';

const SVG_NS = 'http://www.w3.org/2000/svg';

interface ISvgChild {
	readonly tag: string;
	readonly attrs: Readonly<Record<string, string>>;
}

interface ISvgDef {
	readonly viewBox: string;
	readonly sw: number;
	readonly linecap?: string;
	readonly linejoin?: string;
	readonly children: readonly ISvgChild[];
}

/**
 * The two glyphs from the Claude Design "Option A" mock. TUI is a stylized shell
 * prompt (distinct from the full terminal-window icon of the neighbouring "Open
 * Terminal" button); GUI is an app window with content rows. Both stroke
 * `currentColor` so the color comes from the segment's CSS.
 */
const TUI_ICON: ISvgDef = {
	viewBox: '0 0 16 16', sw: 1.3, linecap: 'round', linejoin: 'round', children: [
		{ tag: 'polyline', attrs: { points: '3,5 6,8 3,11' } },
		{ tag: 'line', attrs: { x1: '8', y1: '11', x2: '12.5', y2: '11' } },
	]
};

const GUI_ICON: ISvgDef = {
	viewBox: '0 0 16 16', sw: 1.3, linejoin: 'round', children: [
		{ tag: 'rect', attrs: { x: '2', y: '2.8', width: '12', height: '10.4', rx: '1.8' } },
		{ tag: 'line', attrs: { x1: '2', y1: '6', x2: '14', y2: '6' } },
		{ tag: 'line', attrs: { x1: '4.4', y1: '8.4', x2: '10', y2: '8.4' } },
		{ tag: 'line', attrs: { x1: '4.4', y1: '10.6', x2: '8', y2: '10.6' } },
	]
};

function createSvgIcon(targetDocument: Document, def: ISvgDef): SVGElement {
	const svg = targetDocument.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('viewBox', def.viewBox);
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', String(def.sw));
	svg.setAttribute('focusable', 'false');
	svg.setAttribute('aria-hidden', 'true');
	if (def.linecap) {
		svg.setAttribute('stroke-linecap', def.linecap);
	}
	if (def.linejoin) {
		svg.setAttribute('stroke-linejoin', def.linejoin);
	}
	for (const child of def.children) {
		const el = targetDocument.createElementNS(SVG_NS, child.tag);
		for (const key in child.attrs) {
			el.setAttribute(key, child.attrs[key]);
		}
		svg.appendChild(el);
	}
	return svg;
}

/**
 * Renders the "Option A" view-mode control: a single segmented toggle that
 * collapses the former "Use Claude CLI" and "Use Claude Native UI" buttons into
 * one mutually-exclusive choice — Terminal (TUI) vs rich native GUI — preceded by
 * a divider that groups it apart from the "Open Terminal" button.
 *
 * The two states map onto the existing global mode services: TUI => terminal mode
 * on; GUI => terminal mode off and the Claude-parity native renderer on.
 */
export class SessionViewModeActionViewItem extends BaseActionViewItem {

	private _tuiSegment: HTMLElement | undefined;
	private _guiSegment: HTMLElement | undefined;

	constructor(
		action: IAction,
		@ISessionTerminalModeService private readonly terminalModeService: ISessionTerminalModeService,
		@ISessionClaudeNativeModeService private readonly claudeNativeModeService: ISessionClaudeNativeModeService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super(undefined, action);
	}

	override render(container: HTMLElement): void {
		super.render(container);

		if (!this.element) {
			return;
		}

		const targetDocument = container.ownerDocument;
		this.element.classList.add('agent-view-mode-toggle');

		// Divider that separates the toggle from the "Open Terminal" button.
		dom.append(this.element, dom.$('span.agent-view-mode-toggle__divider'));

		const group = dom.append(this.element, dom.$('div.agent-view-mode-toggle__group'));
		group.role = 'radiogroup';
		group.setAttribute('aria-label', localize('viewMode', "View mode"));

		this._tuiSegment = this._createSegment(targetDocument, group, TUI_ICON, localize('viewAsTui', "View as terminal (TUI)"), () => this._selectTui());
		this._guiSegment = this._createSegment(targetDocument, group, GUI_ICON, localize('viewAsGui', "View as rich GUI"), () => this._selectGui());

		this._register(autorun(reader => {
			const isTui = this.terminalModeService.terminalMode.read(reader);
			this._tuiSegment!.classList.toggle('active', isTui);
			this._tuiSegment!.setAttribute('aria-checked', String(isTui));
			this._guiSegment!.classList.toggle('active', !isTui);
			this._guiSegment!.setAttribute('aria-checked', String(!isTui));
		}));
	}

	private _createSegment(targetDocument: Document, parent: HTMLElement, icon: ISvgDef, label: string, run: () => void): HTMLElement {
		const seg = dom.append(parent, dom.$('div.agent-view-mode-toggle__segment'));
		seg.tabIndex = 0;
		seg.role = 'radio';
		seg.setAttribute('aria-label', label);
		seg.appendChild(createSvgIcon(targetDocument, icon));

		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), seg, label));
		this._register(dom.addDisposableListener(seg, dom.EventType.CLICK, e => {
			dom.EventHelper.stop(e, true);
			run();
		}));
		this._register(dom.addDisposableListener(seg, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				dom.EventHelper.stop(event, true);
				run();
			}
		}));
		return seg;
	}

	private _selectTui(): void {
		this.terminalModeService.setEnabled(true);
	}

	private _selectGui(): void {
		this.terminalModeService.setEnabled(false);
		this.claudeNativeModeService.setEnabled(true);
	}
}

/**
 * Registers the {@link SessionViewModeActionViewItem} as the renderer for the
 * view-mode toggle in the session title-bar toolbar.
 */
export class SessionViewModeToolbarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessionViewModeToolbar';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@ISessionTerminalModeService terminalModeService: ISessionTerminalModeService,
		@ISessionClaudeNativeModeService claudeNativeModeService: ISessionClaudeNativeModeService,
	) {
		super();

		// Refresh the toolbar item whenever either mode flips so the active
		// segment stays in sync even if the view item is recreated.
		const onDidChangeMode = Event.any(
			Event.fromObservableLight(terminalModeService.terminalMode),
			Event.fromObservableLight(claudeNativeModeService.claudeNativeMode),
		);

		this._register(actionViewItemService.register(
			Menus.TitleBarSessionMenu,
			TOGGLE_VIEW_MODE_ACTION_ID,
			(action, _options, instaService) => instaService.createInstance(SessionViewModeActionViewItem, action),
			onDidChangeMode,
		));
	}
}
