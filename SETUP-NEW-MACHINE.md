# Setting up opf2x (and opf18) on a new Linux machine

Replicates the Windows setup: opencode v2 fork (opf2x) and v1.18.5 fork (opf18) running side by side on isolated databases, with the full external plugin set. Prerequisites: Linux x64, git, GitHub SSH keys for `loquilloll`, bash (or zsh — adjust), bun.

Convention below: repos live in `~/git/`. Adjust paths if different — **the `zai.ts` shim contains a relative import that must match your repo location** (step 5).

## 1. Fork repos

```bash
mkdir -p ~/git && cd ~/git
git clone git@github.com:loquilloll/opencode.git
cd opencode
git worktree add ../opencode-v2.2.5 release/v2.2.5     # opf2x (fork mods on upstream tag v2.2.5)
git worktree add ../opencode-v1.18.5 release/v1.18.5   # opf18 (v1 fork) — optional, only if wanted here
git worktree add ../opencode-v1.17.9 release/v1.17.9   # opf17 — optional

# plugin source repos (zai is REQUIRED — its shim imports the source directly)
git clone git@github.com:loquilloll/opencode-zai-tools.git
git clone git@github.com:loquilloll/opencode-ast-grep.git
```

Install deps (system bun 1.3.14 is fine for runtime):

```bash
cd ~/git/opencode-v2.2.5 && bun install
cd ~/git/opencode-v1.18.5 && bun install   # if deploying opf18
cd ~/git/opencode-zai-tools && bun install
cd ~/git/opencode-ast-grep && bun install
```

## 2. Config directory — `~/.local/share` and `~/.config`

Everything under the opencode config dir is machine-local and shared by both forks. Copy the WHOLE tree:

```bash
# from the old machine:
rsync -av --exclude node_modules .config/opencode/ newmachine:.config/opencode/
```

Credentials are NOT in the config dir — see step 2b.

What must exist afterwards (build these if starting from scratch instead of copying):

- `~/.config/opencode/opencode.jsonc` — shared config; its `plugin` list drives the npm plugins (`opencode-websearch`, `@mohak34/opencode-notifier@latest`, `@dietrichgebert/ponytail`, `@prevalentware/opencode-goal-plugin`, `["@plannotator/opencode@latest", {...}]`). npm plugins need NO pre-install — v2 auto-installs them on first boot (that's the fork's plugin-host fix).
- `~/.config/opencode/instructions/*.md` — referenced by opencode.jsonc.
- `~/.config/opencode/skill/` — global skills, including the `opf2x` fork-management skill.
- `~/.config/opencode/plugins/` — **files only, never subdirectories** (v2 turns every subdir into a package target):
  - `ast-grep.ts` — shim, portable (`import plugin, { v2Setup } from "../ast-grep-bundle/plugin.js"`)
  - `zai.ts` — shim; **edit its import to point at your repo location**, e.g. for `~/git/`: `from "../../../git/opencode-zai-tools/src/plugin.ts"`
  - `preemptive-compaction.js` + `preemptive-compaction.config.json` — self-contained bundle, copy as-is
- `~/.config/opencode/ast-grep-bundle/` — built from the repo:

```bash
cd ~/git/opencode-ast-grep && bun run build
mkdir -p ~/.config/opencode/ast-grep-bundle
cp -r dist/* ~/.config/opencode/ast-grep-bundle/
```

## 2b. Credentials (without these, opf2x has NO providers)

v2 keeps credentials in its SQLite DB, and a freshly created DB stamps every migration as done **without replaying the legacy `auth.json` import**. Copying `~/.local/share/opencode/auth.json` to a new machine therefore imports nothing and leaves you with zero providers (only the free `opencode` one). Move them through the CLI instead:

```bash
# old machine
opencode auth export > ~/opencode-auth.json        # or: opencode auth export <integration>
# new machine (after the exe exists, step 5, though any build works)
opencode auth import ~/opencode-auth.json
```

Or connect from scratch with `opencode auth login`. Verify with `opencode auth list` and `opencode models` (expect your providers, not an empty list).

## 3. Databases (fresh start vs. carry history)

Fresh start needs nothing — each fork creates its DB on first run. To carry history from the old machine, copy the four DBs (plus `-wal`/`-shm` sidecars) into `~/.local/share/opencode/`:

- `opencode.db` (npm/dev shared), `opencode-opf18.db` (opf18, frozen), `opencode-opf2x.db` (opf2x), `opencode-pre-opf2x.db` (rollback snapshot)

Rules (see the `opf2x` skill): nothing newer than opf18 ever opens `opencode-opf18.db`; every scripted invocation pins `OPENCODE_DB`.

## 4. Shell functions (`~/.bashrc`)

Same contract as the Windows profile: pin the DB for the child process only, `--standalone` private server for opf2x, caller's directory as the positional.

```bash
opf18() {
  local prev="$OPENCODE_DB"
  export OPENCODE_DB="opencode-opf18.db"
  # --conditions=browser required for source runs (solid-js JSX via monorepo tsconfig)
  bun run --cwd "$HOME/git/opencode-v1.18.5/packages/opencode" --conditions=browser ./src/index.ts "$PWD" "$@"
  local rc=$?
  [ -n "$prev" ] && export OPENCODE_DB="$prev" || unset OPENCODE_DB
  return $rc
}

opf2x() {
  local prev="$OPENCODE_DB" exe="$HOME/git/opencode-v2.2.5/packages/cli/dist/cli-linux-x64/bin/opencode"
  export OPENCODE_DB="opencode-opf2x.db"
  if [ -x "$exe" ]; then "$exe" --standalone "$PWD" "$@"
  else bun run --cwd "$HOME/git/opencode-v2.2.5/packages/cli" --conditions=browser ./src/index.ts --standalone "$PWD" "$@"; fi
  local rc=$?
  [ -n "$prev" ] && export OPENCODE_DB="$prev" || unset OPENCODE_DB
  return $rc
}
```

Also make sure `OPENCODE_DISABLE_CHANNEL_DB=1` is exported globally (keeps npm/dev runs unified on `opencode.db`) — copy that from the old shell profile.

## 5. Build the opf2x exe (recommended — source runs take 25-40s to boot)

Side-by-side bun 1.4.4 (the repo pins it; don't disturb whatever system bun serves the v1 worktrees):

```bash
mkdir -p ~/.local/opt && cd ~/.local/opt
curl -LO https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip
unzip bun-linux-x64.zip && mv bun-linux-x64 bun-1.4.4
~/.local/opt/bun-1.4.4/bun --version   # 1.4.4

cd ~/git/opencode-v2.2.5/packages/cli
PATH="$HOME/.local/opt/bun-1.4.4:$PATH" ~/.local/opt/bun-1.4.4/bun run build --single   # ~6 min
# → dist/cli-linux-x64/bin/opencode
```

## 6. Verify

```bash
# v2: background server, then API checks (exe boots in <1s; first /api/agent pays plugin activation)
OPENCODE_DB=opf2x-verify.db ~/git/opencode-v2.2.5/packages/cli/dist/cli-linux-x64/bin/opencode \
  serve --port 4820 --print-logs > /tmp/opf2x.log 2>&1 &
sleep 3
PASS=$(grep -oP 'password \K\S+' /tmp/opf2x.log | head -1)
curl -s -u "opencode:$PASS" http://127.0.0.1:4820/api/agent  | jq -r '.data[].id' | tr '\n' ' '
# expect 13: build general explore compaction title summary plan browser-use code-reviewer deepdive plan-review duplicate-pr triage
curl -s -u "opencode:$PASS" http://127.0.0.1:4820/api/plugin | jq -r '.data[] | select(.source.type!="builtin") | "\(.id) [\(.source.type)/\(.state.status)]"'
# expect active: ast-grep, zai, preemptive-compaction (local) + opencode-websearch, local.goal-mode.server, opencode-notifier, ponytail, plannotator (package)
kill %1 && rm -f ~/.local/share/opencode/opf2x-verify.db*

# v1 regression (if opf18 deployed):
OPENCODE_DB=opencode-opf18.db bun run --cwd ~/git/opencode-v1.18.5/packages/opencode \
  --conditions=browser ./src/index.ts session list -n 1
# expect: [opencode-zai-tools] registered 13/13 tools. and zero errors
```

## Notes

- "Location plugins did not finish activating" on one-shot CLI commands = source-run boot noise, not a bug; judge via server logs.
- Push from either opencode worktree needs `--no-verify` (pre-push hook gates on the pinned bun version; `bun run typecheck:tsc` from package dirs is the real check).
- If a package plugin ever fails oddly: delete its generation dir under `~/.cache/opencode/npm/<pkg>@<spec>/` and reboot — a clean reinstall fixes it.
- Full fork documentation: `MODIFICATIONS.md` in the worktree root; operational skill: `~/.config/opencode/skill/opf2x/SKILL.md`.
