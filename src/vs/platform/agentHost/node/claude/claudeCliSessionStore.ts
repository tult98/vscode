/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { promises as fs } from 'fs';
import * as os from 'os';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../log/common/log.js';

/**
 * Filesystem-backed reader for the native `claude` CLI's on-disk session
 * store. Used by {@link ClaudeAgentSdkService} when CLI transport is active
 * (`chat.agents.claude.nativeCli` / `chat.agentHost.claudeAgent.useCli`) so the
 * read paths — listing sessions for the sidebar and replaying transcripts —
 * work WITHOUT loading the `@anthropic-ai/claude-agent-sdk` module. This is the
 * piece that lets a built product surface Claude history when the SDK is not
 * bundled.
 *
 * The native CLI persists sessions as JSONL under
 * `<configDir>/projects/<encoded-cwd>/<sessionId>.jsonl`, one envelope per
 * line, with subagent transcripts under
 * `<encoded-cwd>/<sessionId>/subagents/agent-<id>.jsonl`. `configDir` is
 * `$CLAUDE_CONFIG_DIR` when set (matching what the spawned CLI itself reads),
 * else `~/.claude`. The on-disk envelope is structurally the SDK's
 * {@link SessionMessage} (its `.message` is the raw Anthropic message), so the
 * downstream replay mapper consumes our output unchanged.
 *
 * The SDK type imports above are type-only and erased at compile time — this
 * module pulls in no SDK runtime code.
 */

const JSONL_SUFFIX = '.jsonl';
const SUBAGENT_FILE_PREFIX = 'agent-';

/** One parsed JSONL transcript line. Only the fields we read are typed. */
interface IClaudeTranscriptEntry {
	readonly type?: string;
	readonly subtype?: string;
	readonly uuid?: string;
	readonly sessionId?: string;
	readonly cwd?: string;
	readonly gitBranch?: string;
	readonly timestamp?: string;
	readonly isMeta?: boolean;
	readonly isCompactSummary?: boolean;
	readonly isVisibleInTranscriptOnly?: boolean;
	readonly message?: unknown;
	readonly content?: unknown;
	// Title-bearing variants written across CLI versions.
	readonly customTitle?: string;
	readonly aiTitle?: string;
	readonly summary?: string;
	readonly lastPrompt?: string;
}

function claudeConfigDir(): string {
	const override = process.env['CLAUDE_CONFIG_DIR'];
	return override && override.trim().length > 0 ? override : join(os.homedir(), '.claude');
}

function projectsRoot(): string {
	return join(claudeConfigDir(), 'projects');
}

/** Read a file as UTF-8, returning `undefined` if it does not exist / can't be read. */
async function tryReadFile(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, 'utf8');
	} catch {
		return undefined;
	}
}

function parseLines(content: string): IClaudeTranscriptEntry[] {
	const out: IClaudeTranscriptEntry[] = [];
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (parsed && typeof parsed === 'object') {
				out.push(parsed as IClaudeTranscriptEntry);
			}
		} catch {
			// Tolerate partially-written / corrupt lines, matching the
			// reference parser's resilience.
		}
	}
	return out;
}

/**
 * Whether an entry is a renderable message (user / assistant / system) as
 * opposed to a metadata marker (title, mode, snapshot, queue-operation, …).
 * Mirrors the reference parser's `isVisibleNode`.
 */
function isVisibleMessageEntry(raw: IClaudeTranscriptEntry): boolean {
	if (typeof raw.uuid !== 'string') {
		return false;
	}
	const hasMessage = (raw.type === 'user' || raw.type === 'assistant') && raw.message !== undefined && raw.message !== null;
	const hasSystemContent = raw.type === 'system' && typeof raw.content === 'string' && raw.content.length > 0;
	if (!hasMessage && !hasSystemContent) {
		return false;
	}
	if (raw.isCompactSummary === true || raw.isVisibleInTranscriptOnly === true || raw.isMeta === true) {
		return false;
	}
	return true;
}

/**
 * Build the `message` payload the replay mapper expects. User/assistant
 * envelopes pass their raw Anthropic `message` through unchanged; system
 * envelopes carry `subtype` + a string `content` at the top level, which the
 * mapper reads as `{ subtype, text }`.
 */
function toMessagePayload(raw: IClaudeTranscriptEntry): unknown {
	if (raw.type === 'system') {
		return { subtype: raw.subtype, text: typeof raw.content === 'string' ? raw.content : undefined };
	}
	return raw.message;
}

function toSessionMessages(entries: readonly IClaudeTranscriptEntry[], fallbackSessionId: string, includeSystem: boolean): SessionMessage[] {
	const out: SessionMessage[] = [];
	for (const raw of entries) {
		if (!isVisibleMessageEntry(raw)) {
			continue;
		}
		if (raw.type === 'system' && !includeSystem) {
			continue;
		}
		out.push({
			type: raw.type as 'user' | 'assistant' | 'system',
			uuid: raw.uuid!,
			session_id: raw.sessionId ?? fallbackSessionId,
			message: toMessagePayload(raw),
			// Replay transcripts carry no tool-use parent linkage (empirically
			// always null on disk); subagent grouping is resolved separately.
			parent_tool_use_id: null,
		});
	}
	return out;
}

/**
 * CLI slash-command / local-command echoes the subprocess writes to the
 * transcript for restore fidelity — not user-authored prompts, so they make
 * poor titles. Mirrors the spirit of the replay mapper's CLI-echo filter.
 */
const CLI_ECHO_PATTERN = /^\s*<(command-name|command-message|command-args|local-command)/;

/** First user-authored text in the transcript, used as a title fallback. */
function firstUserPrompt(entries: readonly IClaudeTranscriptEntry[]): string | undefined {
	for (const raw of entries) {
		if (raw.type !== 'user' || raw.isMeta === true || !raw.message || typeof raw.message !== 'object') {
			continue;
		}
		const content = (raw.message as { content?: unknown }).content;
		let text: string | undefined;
		if (typeof content === 'string') {
			text = content;
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
					const blockText = (block as { text?: unknown }).text;
					if (typeof blockText === 'string' && blockText.length > 0) {
						text = blockText;
						break;
					}
				}
			}
		}
		if (text && text.length > 0 && !CLI_ECHO_PATTERN.test(text)) {
			return text;
		}
	}
	return undefined;
}

function buildSessionInfo(entries: readonly IClaudeTranscriptEntry[], sessionId: string, lastModified: number, fileSize: number): SDKSessionInfo {
	let customTitle: string | undefined;
	let aiTitle: string | undefined;
	let summaryEntry: string | undefined;
	let lastPrompt: string | undefined;
	let cwd: string | undefined;
	let gitBranch: string | undefined;
	let createdAt: number | undefined;

	for (const raw of entries) {
		if (typeof raw.customTitle === 'string' && raw.customTitle.length > 0) {
			customTitle = raw.customTitle;
		}
		if (typeof raw.aiTitle === 'string' && raw.aiTitle.length > 0) {
			aiTitle = raw.aiTitle;
		}
		if (raw.type === 'summary' && typeof raw.summary === 'string' && raw.summary.length > 0) {
			summaryEntry = raw.summary;
		}
		if (typeof raw.lastPrompt === 'string' && raw.lastPrompt.length > 0) {
			lastPrompt = raw.lastPrompt;
		}
		if (cwd === undefined && typeof raw.cwd === 'string' && raw.cwd.length > 0) {
			cwd = raw.cwd;
		}
		if (gitBranch === undefined && typeof raw.gitBranch === 'string' && raw.gitBranch.length > 0) {
			gitBranch = raw.gitBranch;
		}
		if (createdAt === undefined && typeof raw.timestamp === 'string') {
			const parsed = Date.parse(raw.timestamp);
			if (!isNaN(parsed)) {
				createdAt = parsed;
			}
		}
	}

	const firstPrompt = firstUserPrompt(entries);
	// `project()` displays `customTitle ?? summary`, so put the best available
	// human-readable label in `summary` and keep an explicit /rename title in
	// `customTitle` for priority.
	const summary = aiTitle ?? summaryEntry ?? firstPrompt ?? lastPrompt ?? sessionId;

	return {
		sessionId,
		summary,
		lastModified,
		fileSize,
		customTitle,
		firstPrompt,
		gitBranch,
		cwd,
		createdAt,
	};
}

/** Locate `<sessionId>.jsonl` across all project directories. */
async function findSessionFile(sessionId: string): Promise<{ readonly filePath: string; readonly dir: string } | undefined> {
	const root = projectsRoot();
	let projectDirs: string[];
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		projectDirs = entries.filter(e => e.isDirectory()).map(e => join(root, e.name));
	} catch {
		return undefined;
	}
	const fileName = `${sessionId}${JSONL_SUFFIX}`;
	for (const dir of projectDirs) {
		const filePath = join(dir, fileName);
		try {
			await fs.access(filePath);
			return { filePath, dir };
		} catch {
			// Not in this project dir.
		}
	}
	return undefined;
}

export async function cliListSessions(logService: ILogService): Promise<SDKSessionInfo[]> {
	const root = projectsRoot();
	let projectDirs: string[];
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		projectDirs = entries.filter(e => e.isDirectory()).map(e => join(root, e.name));
	} catch {
		// No projects directory yet — no sessions to surface.
		return [];
	}

	const results: SDKSessionInfo[] = [];
	await Promise.all(projectDirs.map(async dir => {
		let files;
		try {
			files = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		await Promise.all(files.map(async file => {
			if (!file.isFile() || !file.name.endsWith(JSONL_SUFFIX)) {
				return;
			}
			const sessionId = file.name.slice(0, -JSONL_SUFFIX.length);
			const filePath = join(dir, file.name);
			try {
				const [content, stat] = await Promise.all([fs.readFile(filePath, 'utf8'), fs.stat(filePath)]);
				results.push(buildSessionInfo(parseLines(content), sessionId, stat.mtimeMs, stat.size));
			} catch (err) {
				logService.warn(`[Claude CLI] Failed to read session file ${filePath}`, err);
			}
		}));
	}));
	return results;
}

export async function cliGetSessionInfo(sessionId: string, logService: ILogService): Promise<SDKSessionInfo | undefined> {
	const found = await findSessionFile(sessionId);
	if (!found) {
		return undefined;
	}
	try {
		const [content, stat] = await Promise.all([fs.readFile(found.filePath, 'utf8'), fs.stat(found.filePath)]);
		return buildSessionInfo(parseLines(content), sessionId, stat.mtimeMs, stat.size);
	} catch (err) {
		logService.warn(`[Claude CLI] Failed to read session info for ${sessionId}`, err);
		return undefined;
	}
}

export async function cliGetSessionMessages(sessionId: string, includeSystem: boolean, logService: ILogService): Promise<SessionMessage[]> {
	const found = await findSessionFile(sessionId);
	if (!found) {
		return [];
	}
	const content = await tryReadFile(found.filePath);
	if (content === undefined) {
		logService.warn(`[Claude CLI] Failed to read messages for session ${sessionId}`);
		return [];
	}
	return toSessionMessages(parseLines(content), sessionId, includeSystem);
}

function subagentsDir(sessionDir: string, sessionId: string): string {
	return join(sessionDir, sessionId, 'subagents');
}

export async function cliListSubagents(sessionId: string, logService: ILogService): Promise<string[]> {
	const found = await findSessionFile(sessionId);
	if (!found) {
		return [];
	}
	try {
		const entries = await fs.readdir(subagentsDir(found.dir, sessionId), { withFileTypes: true });
		return entries
			.filter(e => e.isFile() && e.name.startsWith(SUBAGENT_FILE_PREFIX) && e.name.endsWith(JSONL_SUFFIX))
			.map(e => e.name.slice(0, -JSONL_SUFFIX.length));
	} catch {
		// No subagents directory for this session.
		return [];
	}
}

export async function cliGetSubagentMessages(sessionId: string, agentId: string, includeSystem: boolean, logService: ILogService): Promise<SessionMessage[]> {
	const found = await findSessionFile(sessionId);
	if (!found) {
		return [];
	}
	const dir = subagentsDir(found.dir, sessionId);
	// Accept the agentId with or without the `agent-` prefix so callers that
	// derive ids from transcript suffixes resolve to the same file.
	const stem = agentId.startsWith(SUBAGENT_FILE_PREFIX) ? agentId : `${SUBAGENT_FILE_PREFIX}${agentId}`;
	const content = await tryReadFile(join(dir, `${stem}${JSONL_SUFFIX}`))
		?? await tryReadFile(join(dir, `${agentId}${JSONL_SUFFIX}`));
	if (content === undefined) {
		logService.warn(`[Claude CLI] Failed to read subagent ${agentId} for session ${sessionId}`);
		return [];
	}
	return toSessionMessages(parseLines(content), sessionId, includeSystem);
}
