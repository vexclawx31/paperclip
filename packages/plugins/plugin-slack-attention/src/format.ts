/**
 * Pure helpers: Slack thread parsing, untrusted-text sanitizing, and message
 * text. Nothing here does I/O.
 */

export interface SlackThreadRef {
  permalink: string;
  channel: string;
  threadTs: string;
}

const THREAD_LINE_RE =
  /Slack thread:\s*(https:\/\/[a-z0-9.-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6}))/;
const PERMALINK_RE = /^(https:\/\/[a-z0-9.-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6}))(?:[?#].*)?$/;

function toThreadRef(match: RegExpExecArray): SlackThreadRef {
  return { permalink: match[1]!, channel: match[2]!, threadTs: `${match[3]}.${match[4]}` };
}

/** Find a `Slack thread: <permalink>` line in an issue description. */
export function parseSlackThreadLine(description: string | null | undefined): SlackThreadRef | null {
  if (!description) return null;
  const match = THREAD_LINE_RE.exec(description);
  return match ? toThreadRef(match) : null;
}

/** Parse a bare Slack message permalink (the configured fallback thread). */
export function parseSlackPermalink(value: string | null | undefined): SlackThreadRef | null {
  if (!value) return null;
  const match = PERMALINK_RE.exec(value.trim());
  return match ? toThreadRef(match) : null;
}

/** Channels the plugin may post into: allowlisted, and never a DM or group DM. */
export function isChannelAllowed(channel: string, allowedChannelIds: readonly string[]): boolean {
  if (!/^[A-Z0-9]+$/.test(channel)) return false;
  if (channel.startsWith("D") || channel.startsWith("G")) return false;
  return allowedChannelIds.includes(channel);
}

/**
 * Make worker-authored text safe for Slack mrkdwn: no mentions (`<!here>`,
 * `<@U..>`), no links or other `<...>` markup, no formatting characters that
 * would break the surrounding bold, whitespace collapsed, and truncated.
 */
export function sanitizeUntrusted(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  let text = value
    .replace(/<[!@#]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (text.length > maxLength) {
    text = `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }
  return text;
}

/** Issue identifiers come from Paperclip, but only a strict shape is put into links. */
export function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z][A-Z0-9]{0,15}-\d{1,9}$/.test(value) ? value : null;
}

/** First item of an approval's runtime description ("recursive delete; ..."). */
export function firstFlag(description: unknown): string {
  if (typeof description !== "string") return "";
  const first = description.split(/[;\n]/)[0] ?? "";
  return sanitizeUntrusted(first, 80);
}

export function minutesLeft(expiresAt: unknown, nowMs: number): number | null {
  if (typeof expiresAt !== "string") return null;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return null;
  return (t - nowMs) / 60_000;
}

function wholeMinutes(left: number): number {
  return Math.max(1, Math.floor(left));
}

export interface BoardLinks {
  boardBaseUrl: string;
  companyUrlKey: string;
}

function link(url: string, label: string): string {
  return `<${url}|${label}>`;
}

export function issueUrl(board: BoardLinks, identifier: string): string {
  return `${board.boardBaseUrl}/${board.companyUrlKey}/issues/${identifier}`;
}

export function approvalUrl(board: BoardLinks, approvalId: string): string {
  return `${board.boardBaseUrl}/${board.companyUrlKey}/approvals/${encodeURIComponent(approvalId)}`;
}

export interface FormattedAsk {
  /** Full text of the first post. */
  text: string;
  /** One-line plain summary reused in the resolved state. */
  headline: string;
  /** Link line reused in the resolved state. */
  resolvedLinks: string;
}

export function formatApprovalAsk(input: {
  board: BoardLinks;
  approvalId: string;
  agentName: string | null;
  isCommandApproval: boolean;
  description: unknown;
  expiresAt: unknown;
  childIdentifier: string | null;
  nowMs: number;
}): FormattedAsk {
  const who = sanitizeUntrusted(input.agentName ?? "", 60) || "An agent";
  let headline: string;
  if (input.isCommandApproval) {
    const flag = firstFlag(input.description);
    headline = `${who} wants to run a privileged command${flag ? ` (${flag})` : ""}`;
  } else {
    headline = `${who} is asking for a board decision`;
  }
  const left = minutesLeft(input.expiresAt, input.nowMs);
  const expiry = left !== null && left > 0 ? ` It expires in about ${wholeMinutes(left)} min.` : "";
  const approval = approvalUrl(input.board, input.approvalId);
  const child = input.childIdentifier;
  const childLink = child ? ` · ${link(issueUrl(input.board, child), child)}` : "";
  const text = [
    `*Approval needed: ${headline}*`,
    `An agent is waiting on you before it continues.${expiry}`,
    `${link(approval, "Review and approve")}${childLink}`,
  ].join("\n\n");
  return { text, headline, resolvedLinks: `${link(approval, "View in Paperclip")}${childLink}` };
}

export function formatApprovalReminder(input: {
  board: BoardLinks;
  approvalId: string;
  minutesLeft: number;
}): string {
  return [
    "*Reminder: approval still waiting*",
    `About ${wholeMinutes(input.minutesLeft)} min left, then it's treated as denied.`,
    link(approvalUrl(input.board, input.approvalId), "Review and approve"),
  ].join("\n\n");
}

export function firstPrompt(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const questions = Array.isArray(record.questions) ? record.questions : [];
  const first = questions[0];
  if (first && typeof first === "object" && typeof (first as Record<string, unknown>).prompt === "string") {
    return (first as Record<string, string>).prompt;
  }
  return typeof record.prompt === "string" ? record.prompt : "";
}

export function formatCardAsk(input: {
  board: BoardLinks;
  identifier: string;
  payload: unknown;
}): FormattedAsk {
  const ask = sanitizeUntrusted(firstPrompt(input.payload), 220) || "A decision is needed.";
  const url = issueUrl(input.board, input.identifier);
  const text = [
    `*Decision needed on ${input.identifier}*`,
    ask,
    `${link(url, "Answer in Paperclip")}, or reply here.`,
  ].join("\n\n");
  return { text, headline: `Decision on ${input.identifier}`, resolvedLinks: link(url, input.identifier) };
}

const APPROVAL_RESOLUTION_PREFIX: Record<string, string> = {
  approved: "✅ Approved —",
  rejected: "❎ Denied or expired —",
  cancelled: "❎ Denied or expired —",
  expired: "❎ Denied or expired —",
  revision_requested: "↩️ Changes requested —",
};

const INTERACTION_RESOLUTION_PREFIX: Record<string, string> = {
  answered: "✅ Answered —",
  accepted: "✅ Accepted —",
  rejected: "❎ Rejected —",
  cancelled: "❎ Cancelled —",
  withdrawn: "❎ Withdrawn —",
  expired: "❎ Expired —",
  failed: "⚠️ Closed —",
};

export function resolutionPrefix(kind: "approval" | "interaction", status: string): string {
  const table = kind === "approval" ? APPROVAL_RESOLUTION_PREFIX : INTERACTION_RESOLUTION_PREFIX;
  return table[status] ?? "☑️ Closed —";
}

export function formatResolved(input: {
  kind: "approval" | "interaction";
  status: string;
  headline: string;
  resolvedLinks: string;
}): string {
  return `${resolutionPrefix(input.kind, input.status)} ${input.headline}\n\n${input.resolvedLinks}`;
}
