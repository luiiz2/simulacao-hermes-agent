// Central configuration bootstrap. This module is imported by every
// environment-sensitive module before its top-level constants are evaluated.

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function parseIdList(value) {
  return [...new Set(String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
}

export function loadEnv(filePath = join(ROOT, ".env"), target = process.env) {
  try {
    for (const rawLine of readFileSync(filePath, "utf8").split("\n")) {
      const line = rawLine.replace(/\r$/, "").trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (match && !(match[1] in target)) {
        target[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
      }
    }
  } catch {}
  return target;
}

// Must run during module evaluation, before opencode.mjs/logger.mjs read env.
loadEnv();

export function getConfig(env = process.env) {
  const allowedUsers = parseIdList(env.TELEGRAM_ALLOWED_USER_IDS);
  const explicitAdmins = parseIdList(env.TELEGRAM_ADMIN_USER_IDS);
  const adminUsers = explicitAdmins.length ? explicitAdmins : allowedUsers.slice(0, 1);
  const maxAttachmentBytes = Number(env.MAX_ATTACHMENT_BYTES || 10 * 1024 * 1024);

  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    allowedUsers,
    adminUsers,
    instagramAllowedUsers: parseIdList(env.INSTAGRAM_ALLOWED_USER_IDS),
    defaultWorkspace: env.DEFAULT_WORKSPACE || env.GATEWAY_WORKDIR || ROOT,
    generalWorkspace: env.GENERAL_WORKSPACE || join(tmpdir(), "hermes-agent-general"),
    serverUrl: env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096",
    serverUser: env.OPENCODE_SERVER_USERNAME || "opencode",
    serverPass: env.OPENCODE_SERVER_PASSWORD || "tgw-local",
    maxAttachmentBytes: Number.isFinite(maxAttachmentBytes) && maxAttachmentBytes > 0
      ? maxAttachmentBytes
      : 10 * 1024 * 1024,
  };
}

export const CFG = getConfig();
