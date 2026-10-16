# Autonomy gap register

Status: living document, started 2026-10-16. Update an entry when its status
changes. Each gap was found while running real work through Paperclip; none
are hypothetical.

Required invariant: unfinished actionable work must have a productive
executor, a verified continuation, or a delivered request for a genuinely
required decision. The operator must not have to chase.

Risk tiers and channel parity are defined in
[2026-10-16-agent-risk-tiers.md](2026-10-16-agent-risk-tiers.md).

Status values: **open** (not started), **in progress**, **fixed (master)**,
**fixed (live)** (deployed to the installed release line), **deferred**
(intentionally postponed, with a reason).

## Continuation and recovery

| # | Gap | Found in | Layer | Status |
|---|-----|----------|-------|--------|
| C1 | Self-parked tasks (blocked on their own unblock action) went silent after one run; approvals that were granted were never picked up again. | Live baseline proof; LIT-105, LIT-97, LIT-85 | Paperclip recovery | fixed (live) — bounded episode, then board escalation |
| C2 | A native self-park was re-escalated on every tick after the board resolved it. | PR #7 review | Paperclip recovery | fixed (live) |
| C3 | A board comment wake that absorbed a self-unblock notification was cancelled when a wait appeared before claim. | PR #7 review | Paperclip wake queue | fixed (live) |
| C4 | A stale pending question card counted as a durable wait. The operator answered by comment instead of using the card. The card (`supersedeOnUserComment=false`) stayed pending, so disposition repair and the periodic sweep both skipped the issue with `durable_wait`, and nothing would ever run again. | LIT-133 (20:11Z) | Paperclip recovery plus interactions | fixed (live) — PR #16 (question cards supersede on the operator's newer comment by default) |
| C5 | Edge case of C4: a card the creator explicitly keeps open (`false`) still counts as a wait after the agent has acted on a newer operator reply. | LIT-133 analysis | Paperclip recovery | fixed (live line, not deployed) — PR #22 (stale-card cutoff, including retry) |
| C7 | Interrupting a run to deliver the operator's own queued message (`operator_interrupted`) is settled as an unknown-effect failure. Recovery stops, the task is blocked, and the operator's answer becomes a deferred wake that is never promoted. The operator's reply killed the work. | LIT-133 (20:27Z) | Paperclip run control plus recovery | fixed (live line, not deployed) — PR #22 (no hold for operator-delivery interrupts; next-turn notice) |
| C8 | The board cannot clear an execution-recovery hold left by a cancelled run. The UI notice only offers Retry for failed or timed-out runs, and `paperclipai issue recovery:resolve` has no `executionReconciliation` option, although the API supports it. | LIT-133 | Paperclip UI plus CLI | fixed (live line, not deployed) — PR #22 (CLI `--reconcile-run-id/--action-outcome/--outcome-evidence`, UI "Reconcile and continue") |
| C9 | A hot restart adopted a running `claude_local` run, but the adopted run later settled as `process_lost`. | Live install 0ae90886a | Paperclip run adoption | open |
| C10 | Scoped "fresh-only" Hermes runs cold-start every time, so each relay hop costs minutes. | LIT-134 | Paperclip Hermes adapter | open |
| C11 | Claude background tasks (for example a long test) are killed when the run ends, so their result never reports back. | Claudy runs | Agent instructions plus adapter | mitigated — Claudy's instructions require long commands in the foreground |
| C6 | A failure with unknown effect is settled to `blocked` plus an agent-error alert, but the task-level inbox item does not say why it is stuck. | Isolated proofs (fail case) | Paperclip attention | open |

## Agent access and channel parity

| # | Gap | Found in | Layer | Status |
|---|-----|----------|-------|--------|
| A1 | Paperclip runs for Hermes agents used the restricted Slack task-bridge key, not the per-run key (403 on company reads). | LIT-129 | Paperclip agent config plus Hermes profile | fixed (live) for Nox — make `scopedRunEnvironment` and `run_environment_allowlist` the default for every `hermes_gateway` agent |
| A2 | Hermes approval requests from Paperclip runs have no approver: they are denied after a 60-second timeout. | LIT-129 | Paperclip Hermes adapter | fixed (live line, not deployed) — PR #21: every Hermes `approval.request` becomes a board approval (redacted, hash-checked, timeout, withdrawal); tier routing to Vex is phase 2b |
| A3 | Hermes redacts `Bearer ` as `***` in session history. The model copies that into code and sends a malformed Authorization header. | LIT-133 | Hermes | open (Hermes owner) — mitigated: Vex uses the `paperclip-api` helper (`~/.hermes/bin`), which builds the Bearer header from the run environment, so agents never hand-write it |
| A4 | An unauthenticated request got a disguised 404 ("Issue not found"), hiding auth mistakes. | LIT-133 | Paperclip authz | fixed (live) — PR #15. Routes that use their own access check still return 404 (deferred) |
| A5 | The AI-connection auth check flagged any mention of auth variable names, including in prose, and blocked `claude_local`. | LIT-131 / LIT-132 | Paperclip AI connections | fixed (live) — PRs #12, #13, #14. The remote sandbox path is still textual (deferred) |
| A6 | Claudy (`claude_local`) and Clipy (`codex_local`) run with all permission checks bypassed, which is broader than any Hermes channel. | Channel review | Agent configuration | open — bring them under the risk tiers |
| A7 | The guardian gates by syntax (heredoc, `-c`, `node -e`), not by effect, which escalates routine work. | LIT-129 | Hermes guardian policy | open — phase 3 |
| A8 | Red-tier actions are not enforced as hard floors that no agent can approve. | Policy | Hermes plus Paperclip | open — phase 4 |
| A9 | Agents that run as the operator's OS user can reach the operator's board CLI login (`~/.local/bin/paperclipai` with its stored context), which would let them act as the board. | LIT-134 | Host isolation plus agent instructions | open — instructions forbid it; durable fix: run agents as separate OS users or keep the board CLI context out of agent reach |

## External tool access (Apex as the reference workload)

| # | Gap | Found in | Layer | Status |
|---|-----|----------|-------|--------|
| T1 | Apex lost its Linear grant profile-wide. Consent-based OAuth broke three ways: the grant went missing, the hosted MCP endpoint did not match the app client, and the `redirect_uri` was not registered. | LIT-133 | Hermes plus provider | fixed — client credentials on the existing Linear app (WEB2 create/delegate/link proven); a developer token is break-glass only |
| T2 | Figma returns 401, and its refresh returns 400. | LIT-133 | Hermes plus provider | in progress — consent redone; awaiting Apex acceptance on the new runtime |
| T3 | No credential health check: expiry and revocation are discovered by a failing user request. | LIT-133 | Fleet tooling | in progress — probe staged, 12 offline tests pass |
| T4 | Login handoff UX: the link was drawn in a framed tmux box, so it could not be copied, and the flow assumed a browser on VexMini. | LIT-133 | Agent runbook | fixed — plain-line, copy-safe links and a remote-browser default are recorded in the Apex runbook and OAuth skill |

## Operator experience

| # | Gap | Found in | Layer | Status |
|---|-----|----------|-------|--------|
| U1 | A pending question card stayed open after the operator replied. Cancel and X only minimized it. | LIT-133 | Paperclip UI plus server | fixed (live) — PR #16 |
| U2 | Occasional 3–6 second health latency spikes (about one per 10 minutes); suspected periodic reapers. | Live probe | Paperclip server | open — unconfirmed |
| U3 | A board approval click may not register: Jamal's Apex cutover approval stayed pending after his click and was approved via CLI with a note. | LIT-134 | Paperclip UI | open — needs a repro |

## Delivery and operations

| # | Gap | Found in | Layer | Status |
|---|-----|----------|-------|--------|
| D1 | The managed git install requires corepack, which Homebrew Node 26 no longer ships. Installs needed a private corepack. | Live installs | Paperclip CLI installer | open |
| D2 | The installed line and master diverge: 11 deployment fixes exist only on the live line, and 233 commits plus 25 migrations exist only on master. Every fix has to land twice. | Live install planning | Release management | open — needs a convergence plan |
| D3 | Source-checkout start with the Vite dev UI crashed ("stack is not iterable") in idle admission. | Isolated proof | Paperclip server | fixed (master) — PR #9 |
| D4 | An isolated proof instance collided with the live launchd label and was blocked by doctor. A unique `PAPERCLIP_INSTANCE_ID` is required. | Isolated proof | Paperclip CLI / docs | open — document it |
| D5 | The gemini unit test probed the host's real CLI and timed out under load. | Qualification | Tests | fixed (master) — PR #10 |
| D6 | The fleet lease helper rejects some characters in the intent text, and a piped acquire hid the failure. | Nox profile edit | Fleet tooling / process | mitigated — the lease result is checked before mutating |
| D7 | `paperclipai agent instructions-file:put` has no `--base-revision-id`, so edits to managed bundles fail with 422 `INSTRUCTION_BASE_REQUIRED`. | Claudy instructions | Paperclip CLI | open — the API already accepts `baseRevisionId` |
| D8 | The protected autonomy builder rejected a composed release as the previous generation (`old release confinement`). | LIT-134 Apex cutover | vex-agent-platform builder | fixed — vex-agent-platform PR #109, operator `operator-204f3335ba95` staged |
