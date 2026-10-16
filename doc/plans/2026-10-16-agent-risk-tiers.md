# Agent risk tiers and channel access parity

Status: approved by the operator on 2026-10-16. Implementation is in progress.

## Goal

Agents make routine decisions themselves. A supervisor agent approves riskier
but recoverable actions. Only clearly dangerous actions are blocked and sent to
a human. An agent has the same access whichever channel invokes it (Slack, CLI
or a Paperclip run), unless a channel is deliberately restricted.

## Principle

Classify an action by its effect, not by its command syntax. Ask three
questions:

1. What can it break, and how far beyond the agent's own workspace?
2. Can it be undone? Is there git history, a backup or a rollback?
3. Does it reach outside the team: money, credentials, external people or
   other tenants?

A heredoc, a `-c` flag or `node -e` is not risky in itself. The same command
shape can be green or red depending on what it does.

## Tiers

### Red: blocked and escalated to a human

No agent, including the supervisor, can approve these actions.

1. Irreversible destruction outside a disposable workspace. This includes
   deleting or overwriting production data, databases or backups, force-pushing
   or deleting shared branches such as `master` or `main`, and deleting files
   outside the agent's workspace.
2. Live production control. This includes installing, deploying, restarting or
   rolling back live services (Paperclip, Hermes gateways, exNox), and changing
   DNS or infrastructure.
3. Money. This includes payments, purchases, new paid services, and raising
   budgets or spend limits.
4. Access and secrets. This includes creating, rotating or sharing
   credentials, changing permissions or approval policies (this document
   included), adding users, and exposing services to the internet.
5. Speaking for the operator outside the team. This includes email or messages
   to customers, third parties or the public, and legal or financial
   commitments.
6. Crossing boundaries. This includes other companies or tenants, and other
   people's private data.
7. Disabling safety controls. This includes approvals, audit logs, budget
   hard-stops and backups.

### Yellow: the supervisor agent (Vex) approves

These actions are riskier, but they are recoverable and stay inside the team:

- Merging reviewed pull requests to `master`, or pushing to shared branches.
- Installing new dependencies or tools, and running unfamiliar scripts.
- Changing shared configuration, or other agents' tasks and assignments.
- Staging deployments, and migrations on non-production copies.
- Deleting things that can be recovered (from git history or a backup).
- Posting in internal team channels.
- Spending within the existing budget above a per-task threshold.

Vex acts as an approver only, not as an executor of its own work. Every yellow
decision is logged, and the operator receives a daily digest of yellow
approvals.

### Green: the agent decides alone (default)

- Reading anything within the agent's scope.
- Running tests, builds and linters in its own workspace.
- Editing code in its own branch or worktree, opening pull requests and
  drafting documents.
- Updating its own Paperclip tasks, comments and documents, and creating child
  tasks as its brief allows.
- Scratch and temporary files inside its workspace.
- Any shell syntax, provided the effect is green.

## Channel parity

The Hermes approval policy is the same for every channel. The difference
between channels is whether a human can answer an approval request:

- Slack: a person can click an approval card.
- Paperclip runs: Hermes emits `approval.request`, but nothing answers it, so
  the request times out after 60 seconds and is denied.
- Cron: denied unless the action is allowlisted. Cron stays restricted on
  purpose.

Parity therefore means that the same rules apply and an approver is always
reachable. It does not mean blanket auto-approval.

Credential parity: in a Paperclip run, an agent uses that run's own scoped
Paperclip key (`PAPERCLIP_API_KEY` together with `PAPERCLIP_RUN_ID`). It does
not use the restricted Slack task-bridge key. This requires two settings:

- In Paperclip: `adapterConfig.scopedRunEnvironment: true`.
- In the Hermes profile: `gateway.api_server.run_environment_allowlist`, listing
  the Paperclip variable names only. Hermes hard-limits this list to those
  names.

## Implementation phases

1. Credential parity for Nox. Vex is already configured. Done when a Paperclip
   run for Nox uses the per-run key.
2. Approval routing. The Paperclip `hermes_gateway` adapter answers
   `approval.request` events. Yellow requests go to Vex. Red requests go to a
   human through the Paperclip board inbox. The Hermes approval timeout is
   raised so that an approver has time to respond.
3. Guardian policy. The Hermes smart-mode guardian applies these tiers.
   Syntax-only gates are narrowed. Broad pattern allowlists are not copied
   between profiles.
4. Hard floors. Red actions are enforced as non-approvable floors in Hermes and
   as Paperclip governed approvals.

Each phase is proven with a live end-to-end task run before the next phase
starts.

## Open items for the channel review

- Claudy (`claude_local`) and Clipy (`codex_local`) run in Paperclip with all
  permission checks bypassed. That is broader than any Hermes channel. Bring
  them under the same tiers.
- Cron stays deny-by-default.
