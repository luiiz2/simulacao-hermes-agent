// Shared authorization and session-ownership policy.

export function isAllowedUser(channel, userId, config = {}) {
  const list = channel === "instagram" ? config.instagramAllowedUsers : config.allowedUsers;
  return (list || []).some((id) => String(id) === String(userId));
}

export function isAdminUser(userId, config = {}) {
  return (config.adminUsers || []).some((id) => String(id) === String(userId));
}

export function sessionTag(channel, userId) {
  const prefix = channel === "telegram" ? "tg" : channel === "instagram" ? "ig" : String(channel).slice(0, 2);
  return `[${prefix}:${userId}]`;
}

export function sessionBelongsToUser(session, channel, userId, owners = null) {
  if (!session?.id) return false;
  const owner = owners?.get(String(session.id));
  if (owner) {
    return owner.channel === channel && String(owner.userId) === String(userId);
  }
  const title = String(session.title || "");
  const legacyTag = `[${String(channel).slice(0, 2)}:${userId}]`;
  return title.startsWith(sessionTag(channel, userId)) || title.startsWith(legacyTag);
}
