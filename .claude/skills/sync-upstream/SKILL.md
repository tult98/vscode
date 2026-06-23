---
name: sync-upstream
description: Sync the Hero Code fork with upstream microsoft/vscode. Use when the user wants to sync the fork, pull/merge upstream changes, update from upstream, "sync with microsoft/vscode", or bring in the latest VS Code commits. Merges upstream/main into a dated sync branch, resolves conflicts using Hero Code branding rules, type-checks, and opens a PR into main (never touches main directly).
---

# Sync the Hero Code fork with upstream microsoft/vscode

This repo (`tult98/vscode`) is a fork of `microsoft/vscode` rebranded as **Hero Code**. Custom work (rebrand, terminal chat view, native Claude CLI) lives directly on `main`. This skill pulls upstream changes into `main` **via a PR**, resolving branding conflicts to the fork's intent.

**Never use GitHub's "Sync fork" button or `gh repo sync`** — they only fast-forward and would propose discarding the Hero Code commits. **Never force-push. Never push to `upstream`.** `main` is only ever updated by the user merging the PR this skill opens.

## Procedure

### 1. Preflight
- Run `git status --porcelain`. If the working tree is dirty, stop and tell the user to commit or stash first — do not proceed.
- Ensure the `upstream` remote exists: `git remote get-url upstream`. If it errors, add it:
  ```sh
  git remote add upstream https://github.com/microsoft/vscode.git
  git remote set-url --push upstream DISABLE
  ```
  (`DISABLE` blocks accidental pushes to Microsoft.)
- Fetch: `git fetch upstream && git fetch origin`.

### 2. Prepare branches
- `git switch main && git pull origin main` to get the latest of your own main.
- If there's nothing to pull, report it and stop: `git log --oneline main..upstream/main` empty means already up to date.
- Create a dated sync branch (compute today's date as `YYYYMMDD` via `date +%Y%m%d`): `git switch -c sync/upstream-<YYYYMMDD>`. If that branch name already exists, append `-2`, `-3`, etc.

### 3. Merge
- `git merge upstream/main`.
- If it merges cleanly, skip to step 5.

### 4. Resolve conflicts — Hero Code branding rules
List conflicts with `git diff --name-only --diff-filter=U`. Resolve by category:

- **Binary resource icons** — `resources/**` (`.icns`, `.ico`, `.png`, `favicon.ico`): always keep ours (the Hero Code violet bracket-caret mark):
  ```sh
  git checkout --ours <file> && git add <file>
  ```
- **`product.json`** — do NOT blind-pick a side; merge hunk by hunk. **Keep the Hero Code identity**: `nameShort`/`nameLong`, `applicationName`, data-folder names, server/tunnel names, `urlProtocol`, `darwinBundleIdentifier`, all Windows names, the generated AppId GUIDs / macOS profile UUIDs, and the Open VSX `extensionsGallery` block. **Take upstream's** new keys and structural additions everywhere the fork didn't customize.
- **Code product fallbacks** — `src/main.ts`, `src/vs/platform/product/common/product.ts`, `src/vs/platform/environment/node/userDataPath.ts`, `src/vs/platform/extensionManagement/common/extensionsScannerService.ts`, `build/lib/builtInExtensions.ts`: keep the Hero Code string values, take upstream's surrounding structural changes.
- **PWA manifest** (`resources/server/manifest.json`) and in-editor watermarks: keep the Hero Code identity.
- **Feature-area conflicts** — terminal chat view / native Claude CLI (chat & agent files): no blind rule. Read both sides, preserve the fork's behavior while integrating upstream's changes. If a conflict is genuinely ambiguous, **stop and ask the user** rather than guessing.

Source of truth for branding values is the rebrand commit:
```sh
git show cbe25c43308 -- product.json
```

After every conflict is resolved: `git add -A && git commit --no-edit`.

### 5. Validate
- Run `npm run typecheck-client` (type-checks `src/`).
- If built-in extensions under `extensions/` changed in the merge, also run `npm run gulp compile-extensions`.
- Fix obvious merge-fallout type errors. If errors are non-trivial, surface them to the user before publishing.

### 6. Publish a PR (never push to main)
- `git push -u origin HEAD`.
- Open a PR into `main`:
  ```sh
  gh pr create --base main --head sync/upstream-<YYYYMMDD> \
    --title "Sync upstream microsoft/vscode (<YYYYMMDD>)" \
    --body "<summary>"
  ```
- The body should summarize: how many upstream commits were pulled (`git log --oneline main..upstream/main | wc -l`, captured before the merge), which files had conflicts and how each was resolved, and the typecheck result. If there were conflicts, note `has-conflicts` so the user reviews those files closely.
- Print the PR URL and tell the user to review and merge it themselves.
