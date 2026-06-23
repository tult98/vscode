@.github/copilot-instructions.md

# Hero Code fork notes

This repository is a fork of `microsoft/vscode`, rebranded as **Hero Code**. The
custom work (rebrand, terminal chat view, native Claude CLI) lives directly on
`main`, which therefore runs ahead of upstream.

- The shared VS Code instructions above are imported from the upstream-tracked
  `.github/copilot-instructions.md` so they stay in sync with upstream and never
  cause merge conflicts. Add Hero Code-specific guidance in this file, below the
  import — not in the upstream file.
- To pull in upstream `microsoft/vscode` changes, use the `/sync-upstream` skill
  (`.claude/skills/sync-upstream/`). It merges `upstream/main` into a dated sync
  branch, resolves branding conflicts to the Hero Code intent, type-checks, and
  opens a PR into `main`. Never use GitHub's "Sync fork" button — it only
  fast-forwards and would offer to discard the Hero Code commits.
