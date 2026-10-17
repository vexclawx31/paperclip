# Autonomous feature flow

Status: proposed, 2026-10-17. It builds on
[2026-10-16-agent-risk-tiers.md](2026-10-16-agent-risk-tiers.md) (who may decide
what) and the [autonomy gap register](2026-10-16-autonomy-gap-register.md) (what
is still broken).

## The idea in one paragraph

Jamal talks to **Vex** on Slack to agree on direction. Vex comes back with a short
plan with the decision points. Jamal gives one green light. Then **Orca** takes
over: a long-lived Claude Code session that orchestrates the build with worker
agents (Claudy, Clipy, Nox). Jamal hears back only for a red-tier decision, a
stall nobody can fix, or "done".

## Cast

| Name | What it is | Job |
|---|---|---|
| **Vex** | Hermes agent on Slack | Jamal's single point of contact. Agrees direction, writes the plan summary, relays red-tier asks, reports done. Does not sit in the middle of the build. |
| **Orca** | Long-lived Claude Code session (tmux on VexMini) | Tech lead for one feature. Splits the work, runs and steers the workers, reviews, debugs, merges (yellow tier), and runs the cleanup. |
| **Claudy** | `claude -p` worker (`claude_local`, resumed per wake) | Bounded coding tasks: one PR, one bug, one investigation. |
| **Clipy** | `codex -p` worker (`codex_local`) | Second implementer and independent reviewer. |
| **Nox** | Hermes agent | Research, digests, and tasks that need its tools. |

"Orca" is a working name; rename it freely.

**Why Orca is not Claudy.** Claudy is a fresh process on every wake. It keeps its
conversation through `--resume`, but it exits at the end of each run, and its
background tasks and watchers die with it. Orchestration needs something that
stays alive: something that watches events, keeps tests running and talks to
other sessions. Workers stay `claude -p`, because that is cheap, isolated and
parallel. Only the lead is long-lived.

## The flow

1. **Direction (Slack).** Jamal pings Vex with the idea. Vex asks only the
   questions it needs to.
2. **Explore (optional).** Vex creates the feature issue in Paperclip and starts
   Orca on it. Orca sends workers to research or prototype in parallel. This
   step is time-boxed (default: half a day).
3. **Plan (one page, ELI5).** Orca drafts and Vex sends Jamal the issue's `plan`
   document, with a link in the thread. It has:
   - what we build and what "done" means: one acceptance check Jamal can try
     himself, and whether done means merged or live;
   - 3–5 decision points, each with a recommendation;
   - every red-tier item we can predict (new credentials or OAuth consent, the
     live deploy, external messages, spend), so they can be pre-approved now;
   - the rollback for each live step;
   - the budget: rough time and the stop-and-ask threshold.
4. **Green light.** Jamal answers the decisions and approves the plan once. That
   approval is the contract for the build.
5. **Build (autonomous).** Orca owns it:
   - one child issue per piece (plugin, skills, source changes), assigned to
     workers; each worker uses its own worktree and branch, writes tests and
     opens a PR;
   - another agent reviews each PR, for one bounded round; merging to the fork
     is yellow tier;
   - per task: about 2 hours, 3 test cycles and 1 review round; after two
     strikes, narrow the scope or escalate, never loop;
   - progress lives as short milestone comments on the issues: readable, never a
     ping.
6. **Done.** Orca runs the acceptance check and the cleanup (below). Then Vex
   tells Jamal in the thread: what shipped, how to try it, what is left.

## How Vex and Orca talk

Through the Paperclip feature issue only. The issue is the shared record, and no
side channel carries decisions.

- **Vex → Orca:** Vex assigns the feature issue, with the approved plan, to Orca.
  Jamal's later Slack replies about the feature go onto the issue as comments.
  With busy-input steer, they reach Orca mid-run.
- **Orca → Vex:** milestone comments. For a decision, a question card or board
  approval on the issue. Vex is woken by those and relays only red-tier ones to
  Slack, as one message with options and a recommendation. Jamal's answer, as a
  card choice or a plain reply, goes back on the issue and wakes Orca.
- **Yellow tier** (merges, config, retries) is decided by Orca, or by Vex as
  approver, and never reaches Jamal.

## Is Orca a native Paperclip agent?

Yes, in two steps:

- **v0 (no new code):** Orca is registered as a Paperclip agent. The Claude Code
  session watches its own assignments with a monitor and acts on them. This is
  how the coordinator in this session already works.
- **v1 (`claude_session` adapter):** Paperclip delivers each wake as a message
  into the running session instead of starting a new process. The run counts as
  finished when the session posts its disposition. If the session is gone, the
  adapter restarts it with `claude --resume`, so the recovery watchdog covers
  Orca like any other agent and the invariant holds. That is: unfinished work has
  a live executor, a verified continuation, or a delivered escalation.

## Who terminates Orca, and when

- One Orca session per feature, so its context stays focused.
- **Normal end:** the feature issue reaches `done` or `cancelled` and the cleanup
  checklist is complete. Orca posts its final disposition and Vex ends the
  session.
- **Deferred:** if Jamal defers the feature, Orca checkpoints (plan updated,
  branches pushed, a "how to resume" note on the issue), cleans up, and Vex ends
  the session. Resuming later starts a fresh Orca from the issue.
- **Idle safety net:** if Orca has no open assigned work for 2 hours, the watchdog
  asks Vex to end it.
- **Lost or crashed:** the watchdog restarts it once with `--resume`. If that
  fails, Vex tells Jamal.

## When Jamal hears from us

| Event | Who tells Jamal | Where |
|---|---|---|
| Plan ready for the green light | Vex | Slack thread + plan link |
| Red-tier decision not pre-approved | Vex | Slack thread + Paperclip card |
| Scope change (the plan turned out wrong) | Vex | Slack thread |
| Stall: no progress after two recovery attempts | Vex | Slack thread, plain words |
| Done | Vex | Slack thread |
| Daily digest (optional) | Vex | one line in the thread, posted silently |

The target is 3–5 contacts per feature: the plan, 0–2 decisions, maybe a
credential consent, and done. More than that is a bug and gets logged in the gap
register.

## Cleanup (the last step, always)

Cleanup runs when work is done, deferred or cancelled, and before Orca ends.
Without it, the disk fills and stale state confuses the next run. Orca runs it
and reports what it removed and what it kept.

- **Git:** remove the feature's worktrees. Delete merged branches locally and on
  the fork. Close or mark superseded PRs.
- **Scratch:** delete the feature's scratch dirs under
  `~/.hermes/cache/scratch/<feature>/`. Keep only the files the final report
  links to.
- **Processes:** stop anything the feature started: dev servers, isolated test
  instances, monitors, background jobs. Never kill generic node or Claude
  processes.
- **Paperclip:** close child issues as `done` or `cancelled`. Archive test
  companies. Withdraw stale question cards and approvals.
- **Test data:** remove temporary PGlite or instance data dirs created for proofs.
- **Never deleted without Jamal:** recovery archives, DB backups, release dirs
  still referenced by a rollback, and anything outside the feature's own paths.
- **Report:** one line in the final comment: freed space, what was kept and why.

A weekly sweep, run by Vex, catches leftovers: orphan worktrees, branches with no
open PR, scratch dirs older than 14 days, and stopped test instances. It deletes
only what is clearly owned by finished work and lists the rest for review.

## Not built yet

- Orca v0: register it as an agent, and write a launch and monitor script.
- The `claude_session` adapter (v1).
- Approval routing of yellow-tier asks to Vex. Today they land on the board.
- Claudy and Clipy still bypass all permission checks (gap A6).
- The cleanup checklist as a skill, plus the weekly sweep.
