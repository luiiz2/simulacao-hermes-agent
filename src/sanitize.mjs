// Outbound sanitizer + secret redaction. Defense-in-depth: nothing reaches a
// channel without passing through sanitizeForChat().

const ANSI_CSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_OTHER = /\x1b[@-_]/g;
const LITERAL_SGR = /\[\d+(?:;\d+)*m/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
// opencode CLI banner lines: "> build · auto/best-coding", "> plan · ...", "build · ..."
const BANNER = /^[^\S\n]*>?\s*(?:build|plan)\s*[·•]\s*\S.*$/gim;

export function stripTerminalNoise(text) {
  let s = String(text ?? "");
  s = s.replace(ANSI_OSC, "");
  s = s.replace(ANSI_CSI, "");
  s = s.replace(ANSI_OTHER, "");
  s = s.replace(/\r/g, "");
  s = s.replace(BANNER, "");
  s = s.replace(LITERAL_SGR, "");
  s = s.replace(CONTROL, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

const SECRET_PATTERNS = [
  [/\bsk-(?:proj-|svcacct-|[A-Za-z0-9_-]{8,})/g, "[REDACTED_SECRET]"],
  [/\bghp_[A-Za-z0-9]{20,}/g, "[REDACTED_SECRET]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_SECRET]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SECRET]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_SECRET]"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}/g, "[REDACTED_BOT_TOKEN]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [REDACTED_SECRET]"],
  [/^([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)[A-Z0-9_]*)\s*=\s*\S+$/gim, "$1=[REDACTED]"],
];

export function redactSecrets(text) {
  let s = String(text ?? "");
  for (const [re, repl] of SECRET_PATTERNS) s = s.replace(re, repl);
  return s;
}

export function sanitizeForChat(text) {
  return redactSecrets(stripTerminalNoise(text));
}
