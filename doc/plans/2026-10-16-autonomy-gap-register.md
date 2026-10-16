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
| C4 | A run that declares a blocker but leaves its task `in_progress` with no durable waiting path got no prompt repair; only the 30-minute stranded sweep remained. An agent said "paused for independent review" without creating a review path. | LIT-133 (20:11Z) | Paperclip recovery | in progress — root cause under investigation |
| C5 | A failure with unknown effect is settled to `blocked` plus an agent-error alert, but the task-level inbox item does not say why it is stuck. | Isolated proofs (fail case) | Paperclip attention | open |

## Agent access and channel parity

| # | Gap | Found in | Layer | Status |
|---|-----|----------|-------|--------|
| A1 | Paperclip runs for Hermes agents used the restricted Slack task-bridge key, not the per-run key (403 on company reads). | LIT-129 | Paperclip agent config plus Hermes profile | fixed (live) for Nox — make `scopedRunEnvironment` and `run_environment_allowlist` the default for every `hermes_gateway` agent |
| A2 | Hermes approval requests from Paperclip runs have no approver: they are denied after a 60-second timeout. | LIT-129 | Paperclip Hermes adapter | open — phase 2: route yellow-tier requests to Vex and red-tier requests to the human |
| A3 | Hermes redacts `Bearer ` as `***` in session history. The model copies that into code and sends a malformed Authorization header. | LIT-133 | Hermes | open — the owner is Hermes redaction; mitigated by Vex's instructions |
| A4 | An unauthenticated request got a disguised 404 ("Issue not found"), hiding auth mistakes. | LIT-133 | Paperclip authz | fixed (live line, not deployed) — PR #15. Routes that use their own access check still return 404 (deferred) |
| A5 | The AI-connection auth check flagged any mention of auth variable names, including in prose, and blocked `claude_local`. | LIT-131 / LIT-132 | Paperclip AI connections | fixed (live) — PRs #12, #13, #14. The remote sandbox path is still textual (deferred) |
| A6 | Claudy (`claude_local`) and Clipy (`codex_local`) run with all permission checks bypassed, which is broader than any Hermes channel. | Channel review | Agent configuration | open — bring them under the risk tiers |
| A7 | The guardian gates by syntax (heredoc, `-c`, `node -e`), not by effect, which escalates routine work. | LIT-129 | Hermes guardian policy | open — phase 3 |
| A8 | Red-tier actions are not enforced as hard floors that no agent can approve. | Policy | Hermes plus Paperclip | open — phase 4 |

## External tool access (Apex as the reference workload)

| # | Gap | Found in | Layer | Status |
|---|-----|----------|-------|--------|
| T1 | Apex lost its Linear grant profile-wide. Consent-based OAuth broke three ways: the grant went missing, the hosted MCP endpoint did not match the app client, and the `redirect_uri` was not registered. | LIT-133 | Hermes plus provider | in progress — switched to client credentials on the existing app (token works, reads WEB2-36) |
| T2 | Figma returns 401, and its refresh returns 400. | LIT-133 | Hermes plus provider | open |
| T3 | No credential health check: expiry and revocation are discovered by a failing user request. | LIT-133 | Fleet tooling | in progress — probe staged, 12 offline tests pass |
| T4 | Login handoff UX: the link was drawn in a framed tmux box, so it could not be copied, and the flow assumed a browser on VexMini. | LIT-133 | Agent runbook | fixed — plain-line, copy-safe links and a remote-browser default are recorded in the Apex runbook and OAuth skill |

## Operator experience

| # | Gap | Found in | Layer | Status |
|---|-----|----------|-------|--------|
| U1 | A pending question card stayed open after the operator replied. Cancel and X only minimized it. | LIT-133 | Paperclip UI plus server | in progress — server-side default: `ask_user_questions` supersede on operator comment; Cancel really cancels |
| U2 | Occasional 3–6 second health latency spikes (about one per 10 minutes); suspected periodic reapers. | Live probe | Paperclip server | open — unconfirmed |

## Delivery and operations

| # | Gap | Found in | Layer | Status |
|---|-----|----------|-------|--------|
| D1 | The managed git install requires corepack, which Homebrew Node 26 no longer ships. Installs needed a private corepack. | Live installs | Paperclip CLI installer | open |
| D2 | The installed line and master diverge: 11 deployment fixes exist only on the live line, and 233 commits plus 25 migrations exist only on master. Every fix has to land twice. | Live install planning | Release management | open — needs a convergence plan |
| D3 | Source-checkout start with the Vite dev UI crashed ("stack is not iterable") in idle admission. | Isolated proof | Paperclip server | fixed (master) — PR #9 |
| D4 | An isolated proof instance collided with the live launchd label and was blocked by doctor. A unique `PAPERCLIP_INSTANCE_ID` is required. | Isolated proof | Paperclip CLI / docs | open — document it |
| D5 | The gemini unit test probed the host's real CLI and timed out under load. | Qualification | Tests | fixed (master) — PR #10 |
| D6 | The fleet lease helper rejects some characters in the intent text, and a piped acquire hid the failure. | Nox profile edit | Fleet tooling / process | mitigated — the lease result is checked before mutating |
