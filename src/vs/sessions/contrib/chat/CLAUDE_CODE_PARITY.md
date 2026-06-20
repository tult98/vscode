# Claude Code GUI Parity Checklist

Tracks the native rewrite of the Agents Window chat GUI to match the Claude Code for VS Code extension (v2.1.183).

## Status legend
- `[E?]` exists natively (Copilot-proven) — Claude-compat **unverified**
- `[E]`  exists and **verified working** against Claude
- `[B]`  exists but **broken** against Claude — needs fix
- `[P]`  partially exists (backend or pieces present, UI/wiring incomplete)
- `[N]`  new — not present, must be built
- `[✓]`  **done** — implemented and verified against Claude

---

## §1 · Conversation transcript (rendering)

- `[E?]` Streaming assistant text (markdown) — `chatMarkdownContentPart`
- `[E?]` Thinking / reasoning blocks (collapsible) — `chatThinkingContentPart`; CLI `--thinking`, `--max-thinking-tokens`, `--thinking-display`
- `[E?]` Tool calls: collapsible header, running spinner, input JSON, output/result — `chatToolInputOutputContentPart`, `toolInvocationParts/`
- `[E?]` Code blocks with syntax highlight + copy/insert actions — `codeBlockPart`
- `[E?]` Inline diffs / file edits with stats — `chatDiffBlockPart`
- `[E?]` References / context used — `chatReferencesContentPart`
- `[E?]` Todo / plan list — `chatTodoListWidget`
- `[E?]` Subagent / Task output grouping — `chatSubagentContentPart`
- `[E?]` Error message rendering + reconnect spinner
- `[N]`  User message attachment thumbnails
- `[N]`  ASCII-art / welcome state
- `[N]`  Message rating (thumbs up/down) + feedback submission
- `[N]`  Proactive suggestions strip
- `[N]`  Context-window usage meter (token count progress)

---

## §2 · Input composer

- `[E?]` Prompt editor + send button (Enter / Ctrl+Enter mode)
- `[E?]` `/` slash commands & skills (completions, prewarm)
- `[E?]` `@` mentions / file & context attach (mention chips)
- `[N]`  `!` bash command mode (prefix `!` to run a shell command)
- `[E?]` Permission-mode switch (Shift+Tab cycle: default → acceptEdits → bypassPermissions)
- `[E?]` Model picker
- `[P]`  Thinking-level / effort picker
- `[N]`  Image / file paste attachments
- `[N]`  Speech-to-text / dictation
- `[E?]` Interrupt / cancel in-flight run

---

## §3 · Permissions / tool approval

- `[P]`  Interactive per-tool permission prompt card (allow / deny / remember) — CLI transport currently auto-approves via `--permission-mode`; interactive path requires wiring `control_request` / `control_response` in `claudeCliQuery.ts`
- `[N]`  Suppressed-permission hint
- `[N]`  "Dangerously skip permissions" toggle

---

## §4 · Session management

- `[E?]` Session list (composite bar / sidebar)
- `[E?]` New conversation / tabs
- `[E?]` Rename session / tab
- `[P]`  Auto-generate session title
- `[E?]` Delete session
- `[E?]` Reopen closed session
- `[P]`  Fork / branch conversation — `branchChatSessionAction.ts`
- `[N]`  Teleport session (move between windows / remotes)
- `[E?]` Resume / persist sessions across restart

---

## §5 · Git / worktrees

- `[E?]` Create worktree for session — `worktreeCreatedTaskDispatcher.ts`
- `[P]`  Git status display
- `[P]`  Checkout branch
- `[N]`  Skip-branch tracking
- `[N]`  Rewind code (undo to a previous turn)

---

## §6 · Plan mode

- `[N]`  Plan preview with inline comments (add / remove)
- `[E?]` Accept / reject proposed diff — `acceptProposedDiff` / `rejectProposedDiff` commands

---

## §7 · MCP servers

- `[P]`  List / enable / disable servers — CLI `--mcp-config`, `--strict-mcp-config`
- `[N]`  Authenticate / reconnect / clear auth / OAuth callback
- `[N]`  Built-in integrations: Jupyter MCP, Chrome MCP, debugger MCP

---

## §8 · Plugins & marketplace

- `[N]`  List / install / uninstall / enable / disable plugins
- `[N]`  Marketplace: list / add / remove / refresh sources

---

## §9 · Auth & account

- `[E?]` Login / logout — CLI transport authenticates from system keychain (`claude login`)
- `[N]`  Usage / quota display
- `[P]`  Claude subscription mode — `chat.agentHost.claudeAgent.useClaudeSubscription`

---

## §10 · Editor / workspace integrations

- `[E?]` Open file / diff / folder / terminal / URL / markdown preview / output panel
- `[E?]` Open config / config file (AI-customization services)
- `[E?]` Insert / get current editor selection
- `[P]`  Read terminal contents
- `[N]`  Remote control toggle

---

## §11 · Surfaces / window placement

- `[E?]` Sidebar / secondary sidebar / editor tab / dedicated window
- `[E?]` Terminal mode (native `claude` CLI embedded in a terminal) — `terminalChatView.ts`

---

## §12 · Onboarding & misc

- `[N]`  Walkthrough / onboarding flow
- `[N]`  Dismissible banners (terminal upsell, review upsell)
- `[E?]` Show logs / output panel
- `[N]`  Native notifications / user dialog prompts
- `[N]`  In-app extension update
- `[E?]` Font / theme config sync

---

## Execution order (one feature group per session)

| Session | Scope |
|---------|-------|
| **0 — ✓ done** | Land this doc; audit `[E?]` items against a real Claude session; stand up `claudeNative` view shell behind toggle |
| 1 | §1 transcript core: text, thinking, tool calls, code blocks, diffs |
| 2 | §2 input core: `/`, `@`, model picker, permission-mode, interrupt; add `!` bash mode |
| 3 | §3 interactive permissions: wire `control_request` / `control_response` |
| 4 | §4 session management + §5 git / worktrees |
| 5 | §1/§2 tail: usage meter, attachment thumbnails, ratings |
| 6+ | §6 plan mode · §7 MCP · §8 plugins · §9 auth/usage · §10 integrations · §12 misc |
