/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Menus } from '../../../browser/menus.js';
import { IsPhoneLayoutContext, SessionsWelcomeVisibleContext } from '../../../common/contextkeys.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { BranchChatSessionAction } from './branchChatSessionAction.js';
import { RunScriptContribution } from './runScriptAction.js';
import './nullInlineChatSessionService.js';
import './nullChatTipService.js';
import './modelPicker.js';
import './agentHostDelegation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ISessionsTasksService, SessionsTasksService } from './sessionsTasksService.js';
import { ISessionTaskRunnerRegistry, SessionTaskRunnerRegistry } from './sessionTaskRunner.js';
import { RegisterDefaultSessionTaskRunnersContribution } from './registerDefaultSessionTaskRunners.js';
import { AgenticPromptsService } from './promptsService.js';
import { IPromptsService } from '../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { IAICustomizationWorkspaceService } from '../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { ICustomizationHarnessService } from '../../../../workbench/contrib/chat/common/customizationHarnessService.js';
import { SessionsAICustomizationWorkspaceService } from './aiCustomizationWorkspaceService.js';
import { SessionsCustomizationHarnessService } from './customizationHarnessService.js';
import { IChatViewFactory } from '../../../services/chatView/browser/chatViewFactory.js';
import { ISessionTerminalModeService, SessionTerminalModeService } from '../../../services/chatView/browser/sessionTerminalMode.js';
import { ISessionTerminalService, SessionTerminalService } from '../../../services/chatView/browser/sessionTerminalService.js';
import { ChatViewFactory } from './chatView.js';
import { SessionViewModeToolbarContribution, TOGGLE_VIEW_MODE_ACTION_ID } from './sessionViewModeActionViewItem.js';
import { CHAT_CATEGORY } from '../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { SessionsChatAccessibilityHelp } from './sessionsChatAccessibilityHelp.js';
import { SessionsOpenerParticipantContribution } from './sessionsOpenerParticipant.js';
import { WorktreeCreatedTaskDispatcher, AGENT_HOST_RUN_WORKTREE_CREATED_TASKS_SETTING } from './worktreeCreatedTaskDispatcher.js';
import { AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING } from './sessionsChatHistory.js';
import '../../sessions/browser/mobile/mobileOverlayContribution.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorAreaFocusContext, IsAuxiliaryWindowContext } from '../../../../workbench/common/contextkeys.js';
import { NEW_SESSION_ACTION_ID } from '../common/constants.js';


class NewChatInSessionsWindowAction extends Action2 {

	constructor() {
		super({
			id: NEW_SESSION_ACTION_ID,
			title: localize2('chat.newEdits.label', "New Chat"),
			category: CHAT_CATEGORY,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 2,
				// Don't shadow Ctrl/Cmd+N (and Ctrl/Cmd+L) when focus is in the
				// editor area so the standard editor commands (new untitled file,
				// expand line selection) handle the shortcut instead.
				when: EditorAreaFocusContext.negate(),
				primary: KeyMod.CtrlCmd | KeyCode.KeyN,
				secondary: [KeyMod.CtrlCmd | KeyCode.KeyL],
				mac: {
					primary: KeyMod.CtrlCmd | KeyCode.KeyN,
					secondary: [KeyMod.WinCtrl | KeyCode.KeyL]
				},
			}
		});
	}

	override run(accessor: ServicesAccessor): void {
		const sessionsService = accessor.get(ISessionsService);
		// Inherit the active session's provider and session type so the new
		// session defaults to the same kind the user is currently working in.
		const activeSession = sessionsService.activeSession.get();
		sessionsService.openNewSession({
			folderUri: activeSession?.workspace.get()?.uri,
			providerId: activeSession?.providerId,
			sessionTypeId: activeSession?.sessionType,
		});
	}
}

registerAction2(NewChatInSessionsWindowAction);


/**
 * Anchor action for the view-mode segmented toggle in the session title bar.
 * The visual control is supplied by {@link SessionViewModeActionViewItem}; this
 * action provides the menu slot, the command-palette/keyboard entry point, and
 * the fallback when the custom view item is unavailable. It toggles between
 * Terminal (TUI) and the normal GUI chat.
 */
class ToggleSessionViewModeAction extends Action2 {

	constructor() {
		super({
			id: TOGGLE_VIEW_MODE_ACTION_ID,
			title: localize2('toggleViewMode', "Toggle Session View Mode (TUI / GUI)"),
			f1: true,
			icon: Codicon.window,
			menu: [{
				id: Menus.TitleBarSessionMenu,
				group: 'navigation',
				order: 11,
				when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), SessionsWelcomeVisibleContext.toNegated(), IsPhoneLayoutContext.negate()),
			}]
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(ISessionTerminalModeService).toggle();
	}
}

registerAction2(ToggleSessionViewModeAction);


// register actions
registerAction2(BranchChatSessionAction);

// register workbench contributions
registerWorkbenchContribution2(RunScriptContribution.ID, RunScriptContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(SessionsOpenerParticipantContribution.ID, SessionsOpenerParticipantContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(RegisterDefaultSessionTaskRunnersContribution.ID, RegisterDefaultSessionTaskRunnersContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(WorktreeCreatedTaskDispatcher.ID, WorktreeCreatedTaskDispatcher, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(SessionViewModeToolbarContribution.ID, SessionViewModeToolbarContribution, WorkbenchPhase.BlockStartup);

// register services
registerSingleton(IPromptsService, AgenticPromptsService, InstantiationType.Delayed);
registerSingleton(ISessionTaskRunnerRegistry, SessionTaskRunnerRegistry, InstantiationType.Delayed);
registerSingleton(ISessionsTasksService, SessionsTasksService, InstantiationType.Delayed);
registerSingleton(IAICustomizationWorkspaceService, SessionsAICustomizationWorkspaceService, InstantiationType.Delayed);
registerSingleton(ICustomizationHarnessService, SessionsCustomizationHarnessService, InstantiationType.Delayed);
registerSingleton(IChatViewFactory, ChatViewFactory, InstantiationType.Delayed);
registerSingleton(ISessionTerminalModeService, SessionTerminalModeService, InstantiationType.Delayed);
registerSingleton(ISessionTerminalService, SessionTerminalService, InstantiationType.Delayed);

// register accessibility help
AccessibleViewRegistry.register(new SessionsChatAccessibilityHelp());

// register configuration
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	properties: {
		[AGENT_HOST_RUN_WORKTREE_CREATED_TASKS_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('chat.agentHost.runWorktreeCreatedTasks', "Whether to automatically run tasks tagged with `\"runOptions\": { \"runOn\": \"worktreeCreated\" }` when a new agent host session worktree is created. Manual `Run Task` invocations are unaffected."),
		},
		[AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('chat.agentSessions.scopedInputHistory', "Controls whether chat input history in the Agents Window is scoped to the current session. Disable this to use shared input history across sessions."),
		},
	},
});
