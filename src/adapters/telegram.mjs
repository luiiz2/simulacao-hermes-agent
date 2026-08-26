// Telegram channel adapter — Bot API long polling, zero deps.
// Interface: start(), stop(), onMessage(cb), onCallback(cb), sendMessage(),
// editMessage(), sendTyping(), sendPhoto(), registerMenu().

export class TelegramAdapter {
  constructor({ token, allowedUserIds, log, initialOffset = 0 }) {
    this.token = token;
    this.allowed = new Set(allowedUserIds.map(String));
    this.log = log;
    this.api = `https://api.telegram.org/bot${token}`;
    this.onMessage = null;
    this.onCallback = null;
    this.onOffset = null;
    this.offset = initialOffset;
    this.running = false;
    this.name = "telegram";
  }

  async _call(method, body) {
    const r = await fetch(`${this.api}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(method === "getUpdates" ? 65_000 : 30_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
    return j.result;
  }

  isAllowed(userId) { return this.allowed.has(String(userId)); }

  async registerMenu(commands) {
    await this._call("setMyCommands", { commands });
  }

  async start() {
    const me = await this._call("getMe");
    this.running = true;
    this.log("info", "telegram_started", { bot: me.username });
    this._poll().catch((e) => this.log("error", "telegram_poll_crashed", { err: e.message }));
    return me;
  }

  async stop() { this.running = false; }

  async _poll() {
    let backoff = 500;
    while (this.running) {
      try {
        const updates = await this._call("getUpdates", {
          timeout: 50,
          offset: this.offset,
          allowed_updates: ["message", "callback_query"],
        });
        backoff = 500;
        if (updates.length) this.onOffset?.(this.offset);
        for (const u of updates) {
          this.offset = u.update_id + 1;
          try {
            if (u.callback_query && this.onCallback) this.onCallback(this.normalizeCallback(u.callback_query));
            else if (u.message?.text && this.onMessage) this.onMessage(this.normalizeMessage(u.message));
          } catch (e) {
            this.log("error", "update_handler_error", { err: e.message });
          }
        }
      } catch (e) {
        this.log("warn", "poll_error", { err: e.message, backoff });
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 8000);
      }
    }
  }

  normalizeMessage(m) {
    return {
      channel: "telegram",
      chatId: String(m.chat.id),
      userId: String(m.from.id),
      username: m.from.username || m.from.first_name || "",
      text: m.text,
      messageId: m.message_id,
      raw: m,
    };
  }

  normalizeCallback(c) {
    return {
      channel: "telegram",
      chatId: String(c.message?.chat?.id),
      userId: String(c.from.id),
      data: c.data,
      callbackId: c.id,
      raw: c,
    };
  }

  async sendTyping(chatId) {
    try { await this._call("sendChatAction", { chat_id: chatId, action: "typing" }); } catch {}
  }

  async sendMessage(chatId, text, extra = {}) {
    const parts = [];
    let t = text || "(sem saída)";
    while (t.length > 4000) { parts.push(t.slice(0, 4000)); t = t.slice(4000); }
    parts.push(t);
    const sent = [];
    for (let i = 0; i < parts.length; i++) {
      sent.push(
        await this._call("sendMessage", {
          chat_id: chatId,
          text: parts[i],
          parse_mode: extra.parse_mode,
          reply_markup: i === parts.length - 1 ? extra.reply_markup : undefined,
          link_preview_options: { is_disabled: true },
        })
      );
    }
    return sent[sent.length - 1];
  }

  async editMessage(chatId, messageId, text, extra = {}) {
    try {
      return await this._call("editMessageText", {
        chat_id: chatId, message_id: messageId, text,
        parse_mode: extra.parse_mode,
        reply_markup: extra.reply_markup,
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      if (!/message is not modified/.test(e.message)) throw e;
    }
  }

  async answerCallback(callbackId, text) {
    try { await this._call("answerCallbackQuery", { callback_query_id: callbackId, text }); } catch {}
  }

  async sendPhoto(chatId, filePath, caption) {
    const form = new FormData();
    form.append("chat_id", chatId);
    if (caption) form.append("caption", caption);
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    form.append("photo", new Blob([await readFile(filePath)]), basename(filePath));
    const r = await fetch(`${this.api}/sendPhoto`, { method: "POST", body: form });
    const j = await r.json();
    if (!j.ok) throw new Error(`sendPhoto: ${j.description}`);
    return j.result;
  }

  async deleteMessage(chatId, messageId) {
    try { await this._call("deleteMessage", { chat_id: chatId, message_id: messageId }); } catch {}
  }
}
