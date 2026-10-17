# Slack Attention plugin (`paperclip.slack-attention`)

Posts every human ask into Slack, event-driven, through the Paperclip plugin
event bus. It replaces the 60-second `attention-bridge` LaunchAgent poller.

## What it does

| Trigger | Action |
|---|---|
| `approval.created`, approval is `pending` | Post one message into the ask's Slack thread |
| `activity.logged`, action `issue.thread_interaction_created`, card is `pending` and `effectiveResolverPolicy === "human_only"` | Post one message into the ask's Slack thread |
| `approval.decided`, or any other `activity.logged` row on a posted approval (`adapter_approval.timed_out`, `adapter_approval.abandoned`, ...) | `chat.update` the same message to a resolved state |
| `activity.logged`, action `issue.thread_interaction_{answered,accepted,rejected,cancelled,withdrawn,expired,skipped,...}` | `chat.update` the same message to a resolved state |
| Job `approval-reminders` (every minute, in-Paperclip scheduler) | Post one reminder when a posted approval has less than `reminderMinutes` left; reconcile decisions whose event was missed; retry failed posts (max 3 attempts) |

Agent-to-agent cards (`anyone`, `not_creator`) are never posted. Asks that were
already pending before the plugin was installed are not posted (there is no
event for them).

### Thread selection

The plugin reads the ask's issue (an approval's `payload.issueId`, or the card's
issue) and walks `parentId` up to 8 levels. The first description that matches

```
Slack thread:\s*(https://[a-z0-9.-]+\.slack\.com/archives/([A-Z0-9]+)/p(\d{10})(\d{6}))
```

gives the channel and `thread_ts` (`first10.last6`). If none matches, or the
matched channel is not allowed, the configured `fallbackThreadPermalink` is
used. Channels must be in `allowedChannelIds`; IDs starting with `D` or `G`
(DMs, group DMs) are always refused. With no allowed thread, nothing is posted.

### Messages

```
*Approval needed: Vex wants to run a privileged command (recursive delete)*

An agent is waiting on you before it continues. It expires in about 12 min.

<BOARD/LIT/approvals/<id>|Review and approve> · <BOARD/LIT/issues/LIT-3|LIT-3>
```

```
*Decision needed on LIT-3*

<first question prompt, whitespace collapsed, at most 220 chars>

<BOARD/LIT/issues/LIT-3|Answer in Paperclip>, or reply here.
```

Resolved messages are rewritten in place, for example
`✅ Approved — Vex wants to run a privileged command (recursive delete)`,
`❎ Denied or expired — ...`, `✅ Answered — Decision on LIT-3`.

The plugin never sends the command, the approval title or summary, or any card
text other than the first prompt. Worker-authored text is treated as untrusted:
`<!`, `<@`, `<#` and all other `<...>` markup and `* _ ~ \`` are stripped, and the
text is truncated. Messages are sent with `link_names: false` and
`parse: "none"`.

### Idempotency and state

Each ask has a record in plugin state (`instance` scope, namespace
`slack-attention`, key `ask:<approval|interaction>:<id>`) holding the Slack
channel and `ts`. The record is written before the Slack call, so a worker
restart never posts the same ask twice. An index key `open-asks` lists asks the
job still watches; entries older than 3 days are dropped.

### Token handling

The bot token is a Paperclip secret, referenced from config key
`slackBotTokenSecret`. It is resolved with `ctx.secrets.resolve` for each Slack
call, never cached, stored or logged; error text is scrubbed of the token and of
any `xox*-` shape. Slack calls go through `ctx.http` to
`https://slack.com/api/chat.postMessage` and `chat.update` only.

## Capabilities

`events.subscribe`, `http.outbound`, `secrets.read-ref`, `plugin.state.read`,
`plugin.state.write`, `jobs.schedule`, `issues.read`, `issue.interactions.read`,
`approvals.read`, `agents.read` (agent display name in the approval headline).

## Host requirement

The plugin needs the host to deliver the documented `activity.logged` plugin
event for every activity row. Hosts before this change only delivered typed
events (for example `approval.decided`), so card asks never arrived. The change
is in `server/src/services/activity-log.ts` (`activityLoggedPluginEvent`).

## Configuration (company-scoped)

| Key | Default | Notes |
|---|---|---|
| `slackBotTokenSecret` | — (required) | `{ "type": "secret_ref", "secretId": "<uuid>", "version": "latest" }` |
| `allowedChannelIds` | `["C0B0ZVAAFK7"]` | Channel IDs only; `D*`/`G*` refused |
| `fallbackThreadPermalink` | `""` | Slack message permalink in an allowed channel |
| `boardBaseUrl` | `https://vexmini.tail8361f8.ts.net:8444` | Must be https and not localhost |
| `companyUrlKey` | `LIT` | Board path prefix |
| `reminderEnabled` | `true` | |
| `reminderMinutes` | `8` | 1 to 120 |

## Build and test

This package is excluded from the pnpm workspace (see `pnpm-workspace.yaml`) so
it adds no lockfile importer; the root `postinstall` links the in-repo SDK into
`node_modules/@paperclipai/plugin-sdk`. The worker bundle inlines the SDK, so the
built `dist/` runs without its own `node_modules`.

```sh
pnpm install --frozen-lockfile                           # repo root; links the SDK
pnpm --dir packages/plugins/plugin-slack-attention build # builds SDK deps, then dist/
pnpm --dir packages/plugins/plugin-slack-attention typecheck
pnpm exec vitest run --project @paperclipai/plugin-slack-attention
```

## Install and configure on a running instance

Run these as an instance admin (board session: `paperclipai auth login`) against
the instance API. On VexMini that is `--api-base http://127.0.0.1:3100`. Replace
`<COMPANY_ID>` with the LIT company ID.

1. Build the plugin from a checkout of the merged line, then copy the built
   package to a stable folder (the host runs a local-path plugin in place, so do
   not point it at a worktree that may be removed):

   ```sh
   pnpm install --frozen-lockfile
   pnpm --dir packages/plugins/plugin-slack-attention build
   mkdir -p ~/.paperclip/local-plugins/slack-attention
   cp -R packages/plugins/plugin-slack-attention/package.json \
         packages/plugins/plugin-slack-attention/dist \
         ~/.paperclip/local-plugins/slack-attention/
   ```

2. Create the token secret. Put the token in an environment variable first so it
   never appears in shell history or process arguments:

   ```sh
   read -rs SLACK_ATTENTION_BOT_TOKEN && export SLACK_ATTENTION_BOT_TOKEN
   paperclipai secrets create -C <COMPANY_ID> \
     --name "Slack attention bot token" --key slack_attention_bot_token \
     --value-env SLACK_ATTENTION_BOT_TOKEN --json
   unset SLACK_ATTENTION_BOT_TOKEN
   ```

   Note the returned `id` (`<SECRET_ID>`). API equivalent:
   `POST /api/companies/<COMPANY_ID>/secrets` with
   `{ "name": "...", "key": "slack_attention_bot_token", "value": "<token>" }`.

3. Install (status becomes `ready`):

   ```sh
   paperclipai plugin install --local ~/.paperclip/local-plugins/slack-attention
   ```

   API: `POST /api/plugins/install` with
   `{ "packageName": "/Users/vex/.paperclip/local-plugins/slack-attention", "isLocalPath": true }`.

4. Save the company config. The secret is referenced, never inlined:

   ```sh
   paperclipai plugin config:set paperclip.slack-attention -C <COMPANY_ID> --payload-json '{
     "configJson": {
       "slackBotTokenSecret": { "type": "secret_ref", "secretId": "<SECRET_ID>", "version": "latest" },
       "allowedChannelIds": ["C0B0ZVAAFK7"],
       "fallbackThreadPermalink": "https://little-family-7.slack.com/archives/C0B0ZVAAFK7/p1792049190910429",
       "boardBaseUrl": "https://vexmini.tail8361f8.ts.net:8444",
       "companyUrlKey": "LIT",
       "reminderEnabled": true,
       "reminderMinutes": 8
     }
   }'
   paperclipai plugin config:test paperclip.slack-attention -C <COMPANY_ID> --payload-json '{"configJson": { ...same... }}'
   ```

   API: `POST /api/plugins/paperclip.slack-attention/config` with
   `{ "companyId": "<COMPANY_ID>", "configJson": { ... } }`. Saving the config
   also binds the secret to the plugin and authorizes the company for the
   reminder job. The worker reads config per event, so no restart is needed.

5. Check: `paperclipai plugin inspect paperclip.slack-attention`,
   `GET /api/plugins/paperclip.slack-attention/health`, and
   `GET /api/plugins/paperclip.slack-attention/jobs`.

6. After the first ask is seen in Slack from the plugin, unload the old poller
   so asks are not posted twice:
   `launchctl bootout gui/$(id -u)/ai.vexfleet.attention-bridge`.

Disable or remove with `paperclipai plugin disable paperclip.slack-attention` /
`paperclipai plugin uninstall paperclip.slack-attention`.
