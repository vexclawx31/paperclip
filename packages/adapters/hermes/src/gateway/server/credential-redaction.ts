// The one credential-shaped redaction list for the Hermes gateway adapter.
// execute.ts applies it to every string it logs or returns (through
// sanitizeSensitiveText and the per-run text redactor), and approval display
// copies use the same redactor, so there is a single redaction path.

const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b(authorization|x-api-key|api-key|cookie)\s*:\s*(?!(?:Bearer|Basic|Token)\b|\[redacted)[^\s"']+/gi, "$1: [redacted]"],
  [/\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"']+)/gi, "$1=[redacted]"],
  // A command-line option at a word start, with its value on the same line.
  [/(^|[\s"'])(--?(?:token|secret|password|passwd|api[-_]?key|auth|key|pat|credentials?))([ \t]+|=)("[^"]*"|'[^']*'|[^\s"']+)/gim, "$1$2$3[redacted]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|pcp_[A-Za-z0-9_-]{16,})\b/g, "[redacted-token]"],
  [/:\/\/([^/\s:@]+):([^/\s@]+)@/g, "://$1:[redacted]@"],
  // Random-looking blobs: long runs that mix upper case, lower case and digits.
  // Pure hex (git SHAs, SHA-256 digests) and ordinary words are kept.
  [/\b(?=[A-Za-z0-9+_-]*[A-Z])(?=[A-Za-z0-9+_-]*[a-z])(?=[A-Za-z0-9+_-]*\d)[A-Za-z0-9+_-]{32,}={0,2}/g, "[redacted-blob]"],
];

export function redactCredentialPatterns(value: string): string {
  let out = value;
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
