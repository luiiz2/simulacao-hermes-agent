// Short-lived, message-aware deduplication for channel updates.

function contentHash(message) {
  let hash = 5381;
  const value = `${message.channel}:${message.userId}:${message.text || ""}`;
  for (const char of value) hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0;
  return String(hash);
}

export function keyForMessage(message) {
  if (message?.messageId !== undefined && message?.messageId !== null) {
    return `${message.channel}:${message.messageId}`;
  }
  return `content:${contentHash(message || {})}`;
}

export class RecentDeduplicator {
  constructor({ ttlMs = 60_000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.seenKeys = new Map();
  }

  has(message) {
    const now = this.now();
    for (const [key, timestamp] of this.seenKeys) {
      if (now - timestamp > this.ttlMs) this.seenKeys.delete(key);
    }
    const key = keyForMessage(message);
    if (this.seenKeys.has(key)) return true;
    this.seenKeys.set(key, now);
    return false;
  }
}
