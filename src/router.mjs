// Pure routing helpers shared by message and callback paths.

import { isAdminUser, isAllowedUser } from "./auth.mjs";

export function parseCommand(text) {
  const value = String(text ?? "").trim();
  if (!value.startsWith("/")) return null;
  const match = value.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const name = match[1].replace(/^\/+/, "").toLowerCase();
  if (!name) return null;
  return { name, args: (match[2] || "").trim() };
}

export function parseCallbackData(data) {
  const value = String(data ?? "").trim();
  if (!value) return null;
  const [kind, ...args] = value.split(":");
  return kind ? { kind, args } : null;
}

export function canDispatchCommand(def, userId, config = {}) {
  if (!def) return false;
  return def.perm !== "admin" || isAdminUser(userId, config);
}

export function canDispatchCallback(def, userId, config = {}, channel = "telegram") {
  return isAllowedUser(channel, userId, config) && canDispatchCommand(def, userId, config);
}
