export const REMINDER_JOB_KEY = "approval-reminders";

/** How many ancestors above the ask's own issue are searched for a Slack thread. */
export const MAX_ANCESTOR_LEVELS = 8;

export interface SecretRefBinding {
  type: "secret_ref";
  secretId: string;
  version?: number | "latest";
}

export interface SlackAttentionConfig {
  slackBotTokenSecret: SecretRefBinding | null;
  allowedChannelIds: string[];
  fallbackThreadPermalink: string;
  boardBaseUrl: string;
  companyUrlKey: string;
  reminderEnabled: boolean;
  reminderMinutes: number;
}

export const DEFAULT_CONFIG: Omit<SlackAttentionConfig, "slackBotTokenSecret"> = {
  allowedChannelIds: ["C0B0ZVAAFK7"],
  fallbackThreadPermalink: "",
  boardBaseUrl: "https://vexmini.tail8361f8.ts.net:8444",
  companyUrlKey: "LIT",
  reminderEnabled: true,
  reminderMinutes: 8,
};

export function isSecretRefBinding(value: unknown): value is SecretRefBinding {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { type?: unknown }).type === "secret_ref"
    && typeof (value as { secretId?: unknown }).secretId === "string"
    && (value as { secretId: string }).secretId.length > 0;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

export function normalizeConfig(raw: Record<string, unknown> | null | undefined): SlackAttentionConfig {
  const input = raw ?? {};
  const reminderMinutes = typeof input.reminderMinutes === "number" && Number.isFinite(input.reminderMinutes)
    ? Math.min(120, Math.max(1, Math.floor(input.reminderMinutes)))
    : DEFAULT_CONFIG.reminderMinutes;
  return {
    slackBotTokenSecret: isSecretRefBinding(input.slackBotTokenSecret) ? input.slackBotTokenSecret : null,
    allowedChannelIds: stringList(input.allowedChannelIds) ?? [...DEFAULT_CONFIG.allowedChannelIds],
    fallbackThreadPermalink: typeof input.fallbackThreadPermalink === "string"
      ? input.fallbackThreadPermalink.trim()
      : DEFAULT_CONFIG.fallbackThreadPermalink,
    boardBaseUrl: typeof input.boardBaseUrl === "string" && input.boardBaseUrl.trim()
      ? input.boardBaseUrl.trim().replace(/\/+$/, "")
      : DEFAULT_CONFIG.boardBaseUrl,
    companyUrlKey: typeof input.companyUrlKey === "string" && /^[A-Za-z0-9_-]+$/.test(input.companyUrlKey.trim())
      ? input.companyUrlKey.trim()
      : DEFAULT_CONFIG.companyUrlKey,
    reminderEnabled: typeof input.reminderEnabled === "boolean" ? input.reminderEnabled : DEFAULT_CONFIG.reminderEnabled,
    reminderMinutes,
  };
}

/** A board URL is usable when it is https and does not point at the local machine. */
export function isUsableBoardUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host === "0.0.0.0" || host === "[::1]" || host === "::1" || /^127\./.test(host)) return false;
  return true;
}
