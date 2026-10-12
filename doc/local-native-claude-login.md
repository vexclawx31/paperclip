# Local native Claude login (operator-admitted)

A `claude_local` agent can run with the host's own native Claude Code login instead of a Paperclip-managed credential. This is an explicit, operator-admitted, trusted-local mode.

## Admission

Explicit `adapterConfig.localClaudeLogin: true` requires the operator-owned server environment variable `PAPERCLIP_LOCAL_CLAUDE_LOGIN_TARGET_JSON`, with exact `companyId`, `agentId`, `userId`, `host`, `uid`, `home`, `configDir`, `model`, `command` and `path` pins. Missing or malformed admission fails closed. These pins are never accepted from agent configuration, and deployment identities do not belong in source. The agent keeps its `responsible_user` Anthropic subscription binding and managed connection history; a connection-router pool binding is not accepted for this mode.

Default-home mode only: the admitted `configDir` must equal `<home>/.claude`; any other value fails closed. On macOS an explicit `CLAUDE_CONFIG_DIR`, even one equal to `~/.claude`, selects a different native credential context, so native launches (execution, version check, login, local Test probe) remove `CLAUDE_CONFIG_DIR` from the final child environment after the host environment merge. Ordinary and managed callers keep their existing `CLAUDE_CONFIG_DIR` behavior.

## Credential boundary

Paperclip never reads, exports, copies or stores a native token. The CLI runs the admitted absolute command with the admitted `PATH` and `HOME` (and therefore its default config directory), with host loader variables (`NODE_OPTIONS`, `NODE_PATH`, `LD_*`, `DYLD_*`, `BASH_ENV`, `ENV`, `ZDOTDIR`) stripped at the final spawn and competing provider auth variables blanked. Native Claude owns login and refresh.

Preparation rejects competing auth in native settings and project settings. Foreign identities, remote/sandbox targets, restricted filesystem/network contexts, managed connections and extra CLI arguments fail closed. Managed execution never falls back to native login. Task credentials (the run JWT in `PAPERCLIP_API_KEY`), permissions and concurrency are unchanged.

## Trusted-local execution

Beyond the auth isolation above, the native lane uses ordinary Claude CLI behavior: normal runtime MCP servers, skills and settings, and the normal Paperclip API lifecycle (comments and status through the skill's API calls with the run JWT). Unattended tool execution uses the existing `dangerouslySkipPermissions` switch (default true); an explicit `false` is respected. No native-only CLI restrictions (safe mode, empty setting sources, disabled slash commands, tool allowlists) are added. Optional future hardening — a sandboxed filesystem/network scope or narrower tool permissions — would apply the same way to all local agents.

## Disposition-only recovery presentation

The legacy disposition-repair instruction asks for lifecycle-only updates. Server-side, a repair run's closing message is not auto-posted (and no missing-comment retry is queued) only when all of these hold:

- The run is bound to its own successful source run (same company, agent, issue and episode).
- Recovery recorded the issue's `status_version` when it scheduled the repair (`dispositionRepairIssueStatusVersion`), and the current version is exactly one higher. A database trigger bumps it on every status change, so A→B→A or any extra change breaks this.
- The repair run itself logged a successful `issue.updated` with the current status (normal API write by this run and agent).
- The disposition is durable: done or cancelled, blocked with a blocker relation, unblock descriptor or pending interaction/approval, or in_review backed by such a wait path.

Otherwise the message is shown. Explicit comments the run wrote are always shown (reused, not duplicated). Activity timestamps are not consulted. This is not exactly-once presentation.

## Rollback

Set `localClaudeLogin` back to `false` (and restore the prior `dangerouslySkipPermissions` value if it was changed), preserving the binding, model, permissions/concurrency and connection history. Native login is not revoked, deleted or transplanted. No database migration is introduced.
