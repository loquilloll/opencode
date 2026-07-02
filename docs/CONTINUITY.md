# CONTINUITY

## [PLANS]

## [DECISIONS]
- [id:decisions-202606271149-user-9b57114ccfc6] 2026-06-27T11:49Z [USER] User chose to stop at the source fix (index.ts lazy-loading) and accept the remaining ~2.4s TUI / ~0.8s --version gap, which is intrinsic to loading the full server graph from uncompiled source. Declined build-a-worker-bundle and build-full-binary options (would require rebuild on code changes).

## [PROGRESS]

## [DISCOVERIES]
- [id:discoveries-202606271149-code-6445ca7e189d] 2026-06-27T11:49Z [CODE] opf17 = the opencode-v1.17.9 fork run from source via bun (psmux sessions opf17run/opf17real). Published `opencode` is a compiled Bun binary (opencode-ai/bin/opencode.exe). Source-vs-compiled is the fundamental startup difference.
- [id:discoveries-202606271149-code-ba44db01508f] 2026-06-27T11:49Z [CODE] Fork cold-start cost breakdown: bare bun ~0.5s; eager command imports in src/index.ts ~1.8s (mcp.ts ~1.2s via @modelcontextprotocol/sdk+@clack/prompts, run.ts ~0.6s); TUI worker importing @/server/server ~4s (full app graph: httpapi/server pulls Session/Provider/MCP/Plugin/LSP/etc).

## [OUTCOMES]
- [id:outcomes-202606271149-code-c76f75b6afcb] 2026-06-27T11:49Z [CODE] Made src/index.ts register all ~23 yargs commands via a lazy() helper that dynamic-imports each command module only when invoked. TUI first-render 4.9s->3.6s; --version 2.7s->1.6s. Published opencode.exe TUI ~1.2s. Typecheck clean, all commands/aliases(auth,plug)/help/logo paths verified.
