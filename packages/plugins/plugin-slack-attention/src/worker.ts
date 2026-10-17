import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { registerSlackAttention } from "./attention.js";
import { isUsableBoardUrl, normalizeConfig } from "./config.js";
import { isChannelAllowed, parseSlackPermalink } from "./format.js";

const plugin = definePlugin({
  async setup(ctx) {
    registerSlackAttention(ctx);
    ctx.logger.info("slack-attention: subscribed to approval and activity events");
  },

  async onHealth() {
    return { status: "ok", message: "Slack attention plugin ready" };
  },

  // Config is read per event, so a config change needs no worker restart.
  async onConfigChanged() {},

  async onValidateConfig(raw) {
    const config = normalizeConfig(raw);
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!config.slackBotTokenSecret) {
      errors.push("slackBotTokenSecret must be a secret reference ({ type: \"secret_ref\", secretId }).");
    }
    if (!isUsableBoardUrl(config.boardBaseUrl)) {
      errors.push("boardBaseUrl must be an https URL that is not localhost.");
    }
    const refused = config.allowedChannelIds.filter((id) => !isChannelAllowed(id, [id]));
    if (refused.length > 0) {
      errors.push(`allowedChannelIds may not contain DMs, group DMs or malformed IDs: ${refused.join(", ")}`);
    }
    if (config.allowedChannelIds.length === 0) errors.push("allowedChannelIds must list at least one channel.");
    if (config.fallbackThreadPermalink) {
      const fallback = parseSlackPermalink(config.fallbackThreadPermalink);
      if (!fallback) errors.push("fallbackThreadPermalink is not a Slack message permalink.");
      else if (!isChannelAllowed(fallback.channel, config.allowedChannelIds)) {
        errors.push("fallbackThreadPermalink points at a channel that is not in allowedChannelIds.");
      }
    } else {
      warnings.push("No fallbackThreadPermalink: asks without a 'Slack thread:' ancestor will not be posted.");
    }
    return { ok: errors.length === 0, errors, warnings };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
