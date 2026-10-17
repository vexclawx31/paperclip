import type { PluginHttpClient } from "@paperclipai/plugin-sdk";

const SLACK_API_BASE = "https://slack.com/api/";
const ALLOWED_METHODS = new Set(["chat.postMessage", "chat.update"]);

export class SlackApiError extends Error {
  constructor(readonly slackError: string) {
    super(`Slack API error: ${slackError}`);
    this.name = "SlackApiError";
  }
}

/** Remove every occurrence of the token (and any xox* token shape) from a message. */
export function scrubSecrets(message: string, token?: string | null): string {
  let out = message;
  if (token) out = out.split(token).join("[redacted]");
  return out.replace(/xox[a-z]-[A-Za-z0-9-]+/g, "[redacted]");
}

export interface SlackPostResult {
  channel: string;
  ts: string;
}

/**
 * Minimal Slack Web API client over `ctx.http`. Only the two chat methods the
 * plugin needs are callable, and only against slack.com. The token is passed
 * per call and never stored on the client.
 */
export function createSlackClient(http: PluginHttpClient) {
  async function call(method: string, token: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!ALLOWED_METHODS.has(method)) throw new Error(`Slack method not allowed: ${method}`);
    let response: Response;
    try {
      response = await http.fetch(`${SLACK_API_BASE}${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Slack request failed: ${scrubSecrets(message, token)}`);
    }
    let json: Record<string, unknown> | null = null;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      json = null;
    }
    if (!json || json.ok !== true) {
      const code = typeof json?.error === "string" ? json.error : `http_${response.status}`;
      throw new SlackApiError(scrubSecrets(code, token));
    }
    return json;
  }

  return {
    async postMessage(token: string, input: { channel: string; threadTs: string; text: string }): Promise<SlackPostResult> {
      const json = await call("chat.postMessage", token, {
        channel: input.channel,
        thread_ts: input.threadTs,
        text: input.text,
        mrkdwn: true,
        unfurl_links: false,
        unfurl_media: false,
        link_names: false,
        parse: "none",
      });
      const channel = typeof json.channel === "string" ? json.channel : input.channel;
      const ts = typeof json.ts === "string" ? json.ts : "";
      if (!ts) throw new SlackApiError("missing_ts");
      return { channel, ts };
    },
    async updateMessage(token: string, input: { channel: string; ts: string; text: string }): Promise<void> {
      await call("chat.update", token, {
        channel: input.channel,
        ts: input.ts,
        text: input.text,
        link_names: false,
        parse: "none",
      });
    },
  };
}

export type SlackClient = ReturnType<typeof createSlackClient>;
