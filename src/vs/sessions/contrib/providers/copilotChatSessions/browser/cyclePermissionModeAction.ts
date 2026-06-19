/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { CHAT_CATEGORY } from '../../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { IChatSessionsService } from '../../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { SessionsFocusContext } from '../../../../common/contextkeys.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import {
	ALLOW_AUTO_PERMISSIONS_SETTING,
	ALLOW_BYPASS_PERMISSIONS_SETTING,
	autoPermissionMode,
	bypassPermissionMode,
	PERMISSION_MODE_OPTION_ID,
	permissionModes,
} from './claudePermissionModePicker.js';
import { CopilotChatSessionsProvider } from './copilotChatSessionsProvider.js';

class CyclePermissionModeAction extends Action2 {

	constructor() {
		super({
			id: 'agentSession.cyclePermissionMode',
			title: localize2('cyclePermissionMode', "Cycle Permission Mode"),
			category: CHAT_CATEGORY,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 2,
				when: SessionsFocusContext,
				primary: KeyMod.Shift | KeyCode.Tab,
			},
		});
	}

	override run(accessor: ServicesAccessor): void {
		const sessionsService = accessor.get(ISessionsService);
		const chatSessionsService = accessor.get(IChatSessionsService);
		const sessionsProvidersService = accessor.get(ISessionsProvidersService);
		const configurationService = accessor.get(IConfigurationService);

		const activeSession = sessionsService.activeSession.get();
		if (!activeSession) {
			return;
		}

		const provider = sessionsProvidersService.getProvider(activeSession.providerId);
		if (!(provider instanceof CopilotChatSessionsProvider)) {
			return;
		}

		const chatSession = provider.getSession(activeSession.sessionId);
		if (!chatSession) {
			return;
		}

		const autoAvailable = configurationService.getValue<boolean>(ALLOW_AUTO_PERMISSIONS_SETTING) ?? false;
		const bypassAvailable = configurationService.getValue<boolean>(ALLOW_BYPASS_PERMISSIONS_SETTING) ?? false;
		const availableModes = [...permissionModes];
		if (autoAvailable) {
			availableModes.push(autoPermissionMode);
		}
		if (bypassAvailable) {
			availableModes.push(bypassPermissionMode);
		}

		const currentOption = chatSessionsService.getSessionOption(chatSession.resource, PERMISSION_MODE_OPTION_ID);
		const currentModeId = typeof currentOption === 'string' ? currentOption : (currentOption?.id ?? 'acceptEdits');
		const currentIndex = availableModes.findIndex(m => m.id === currentModeId);
		const nextMode = availableModes[(currentIndex + 1) % availableModes.length];

		const option = { id: nextMode.id, name: nextMode.label };
		if (chatSession.setOption) {
			chatSession.setOption(PERMISSION_MODE_OPTION_ID, option);
		} else {
			chatSessionsService.setSessionOption(chatSession.resource, PERMISSION_MODE_OPTION_ID, option);
		}
	}
}

registerAction2(CyclePermissionModeAction);
