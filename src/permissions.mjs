// Permission selection shared by text commands and Telegram callbacks.

export const PERMISSION_TTL_MS = 30 * 60_000;

export function isPermissionAskedEvent(type) {
  return /^permission(?:\.v2)?\.asked$/i.test(String(type ?? "").trim());
}

export function normalizePermissionId(value) {
  return String(value ?? "").trim().replace(/`/g, "");
}

function isFresh(entry, now, ttlMs) {
  return entry && Number.isFinite(entry.ts) && now - entry.ts <= ttlMs;
}

function belongsToTarget(entry, target) {
  return entry?.channel === target?.channel && String(entry?.chatId) === String(target?.chatId);
}

export function selectPendingPermission(
  pending,
  rawId,
  target,
  now = Date.now(),
  ttlMs = PERMISSION_TTL_MS,
) {
  const id = normalizePermissionId(rawId);
  if (id) {
    const entry = pending.get(id);
    if (!entry) return { status: "missing", id };
    if (!isFresh(entry, now, ttlMs)) return { status: "expired", id, entry };
    return { status: "found", id, entry, inferred: false };
  }

  const matches = [...pending.entries()].filter(([, entry]) =>
    belongsToTarget(entry, target) && isFresh(entry, now, ttlMs)
  );
  if (matches.length === 1) {
    const [inferredId, entry] = matches[0];
    return { status: "found", id: inferredId, entry, inferred: true };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", ids: matches.map(([pendingId]) => pendingId) };
  }
  return { status: "missing", id: "" };
}

export function permissionMarkup(id) {
  return {
    inline_keyboard: [[
      { text: "✅ Aprovar", callback_data: `perm:${id}:y` },
      { text: "🚫 Negar", callback_data: `perm:${id}:n` },
    ]],
  };
}
