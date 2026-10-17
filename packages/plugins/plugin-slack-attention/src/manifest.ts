import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, REMINDER_JOB_KEY } from "./config.js";

export const PLUGIN_ID = "paperclip.slack-attention";
export const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Slack Attention",
  description:
    "Posts every human ask (pending board approvals and human-only decision cards) once into the matching Slack thread, and marks the message resolved when the ask is decided or answered.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "events.subscribe",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "jobs.schedule",
    "issues.read",
    "issue.interactions.read",
    "approvals.read",
    "agents.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      slackBotTokenSecret: {
        format: "secret-ref",
        title: "Slack bot token",
        description:
          "Paperclip secret reference holding the Slack bot token (xoxb-...). The bot needs chat:write in the allowed channels. The value is resolved per call and never stored or logged.",
      },
      allowedChannelIds: {
        type: "array",
        title: "Allowed Slack channel IDs",
        description: "The plugin only posts into these channels. IDs starting with D or G (DMs, group DMs) are always refused.",
        items: { type: "string", pattern: "^[A-Z0-9]+$" },
        default: DEFAULT_CONFIG.allowedChannelIds,
      },
      fallbackThreadPermalink: {
        type: "string",
        title: "Fallback thread permalink",
        description:
          "Slack message permalink (https://<workspace>.slack.com/archives/<channel>/p<ts>) used when no ancestor issue carries a 'Slack thread:' line.",
        default: DEFAULT_CONFIG.fallbackThreadPermalink,
      },
      boardBaseUrl: {
        type: "string",
        title: "Board base URL",
        description: "Base URL for links back to Paperclip. Must be https and not localhost.",
        default: DEFAULT_CONFIG.boardBaseUrl,
      },
      companyUrlKey: {
        type: "string",
        title: "Company URL key",
        description: "The company prefix used in board links, e.g. LIT in /LIT/issues/LIT-1.",
        default: DEFAULT_CONFIG.companyUrlKey,
      },
      reminderEnabled: {
        type: "boolean",
        title: "Post an expiry reminder",
        description: "Post one reminder in the thread when a pending approval is close to expiring.",
        default: DEFAULT_CONFIG.reminderEnabled,
      },
      reminderMinutes: {
        type: "integer",
        title: "Reminder threshold (minutes)",
        minimum: 1,
        maximum: 120,
        default: DEFAULT_CONFIG.reminderMinutes,
      },
    },
  },
  jobs: [
    {
      jobKey: REMINDER_JOB_KEY,
      displayName: "Approval reminders and reconcile",
      description:
        "Every minute: posts one reminder for pending approvals that are about to expire, marks asks resolved if a decision event was missed, and retries failed posts.",
      schedule: "* * * * *",
    },
  ],
};

export default manifest;
