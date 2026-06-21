/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IChatTerminalToolInvocationData, IChatToolInvocation, IChatToolInvocationSerialized } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { isToolResultInputOutputDetails } from '../../../../../workbench/contrib/chat/common/tools/languageModelToolsService.js';

/** Display status of a tool call, derived from its (live or serialized) state. */
export type ClaudeToolStatus = 'running' | 'done' | 'error';

/**
 * Pure extractors that turn a tool invocation (live or serialized) into the
 * primitives the transcript renderer needs to draw a Claude-style tool card.
 * Kept free of DOM/services so the rendering logic stays small and testable.
 */

export function getToolStatus(tool: IChatToolInvocation | IChatToolInvocationSerialized): ClaudeToolStatus {
	if (tool.kind === 'toolInvocationSerialized') {
		return tool.isComplete ? 'done' : 'running';
	}
	switch (tool.state.get().type) {
		case IChatToolInvocation.StateKind.Completed:
			return 'done';
		case IChatToolInvocation.StateKind.Cancelled:
			return 'error';
		default:
			return 'running';
	}
}

export function getToolStatusIcon(status: ClaudeToolStatus): ThemeIcon {
	switch (status) {
		case 'done': return Codicon.check;
		case 'error': return Codicon.error;
		default: return Codicon.loading;
	}
}

/** The tool's input rendered as a compact string, or `undefined` if there is none to show. */
export function getToolInput(tool: IChatToolInvocation | IChatToolInvocationSerialized): string | undefined {
	const data = tool.toolSpecificData;
	if (!data) {
		return undefined;
	}
	if (data.kind === 'input') {
		try {
			return JSON.stringify(data.rawInput, undefined, 2);
		} catch {
			return undefined;
		}
	}
	if (data.kind === 'terminal') {
		// Modern terminal data carries `commandLine`; the legacy shape (pre-1.104)
		// does not and falls through to `undefined`.
		return (data as IChatTerminalToolInvocationData).commandLine?.original;
	}
	return undefined;
}

/** The tool's textual output, joined from its embedded text results, or `undefined`. */
export function getToolOutput(tool: IChatToolInvocation | IChatToolInvocationSerialized): string | undefined {
	const details = tool.kind === 'toolInvocationSerialized' ? tool.resultDetails : undefined;
	if (!isToolResultInputOutputDetails(details)) {
		return undefined;
	}
	const parts: string[] = [];
	for (const entry of details.output) {
		if (entry.type === 'embed' && entry.isText) {
			parts.push(entry.value);
		}
	}
	const text = parts.join('\n').trim();
	return text || undefined;
}
