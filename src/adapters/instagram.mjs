// Instagram Direct adapter — Meta Graph API (official) ONLY.
// No browser automation, no password scraping, no unofficial APIs.
//
// Requires (env): INSTAGRAM_ENABLED=true, META_ACCESS_TOKEN,
// INSTAGRAM_ACCOUNT_ID, META_VERIFY_TOKEN, META_APP_SECRET.
// Inbound: webhook (needs public HTTPS URL or tunnel). Outbound: /me/messages.
//
// Without credentials this adapter stays DISABLED and never affects Telegram
// (isolation requirement).

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const GRAPH = "https://graph.facebook.com/v21.0";

export class InstagramAdapter {
  constructor({ log }) {
    this.log = log;
    this.name = "instagram";
    this.enabled = process.env.INSTAGRAM_ENABLED === "true";
    this.token = process.env.META_ACCESS_TOKEN || "";
    this.accountId = process.env.INSTAGRAM_ACCOUNT_ID || "";
    this.verifyToken = process.env.META_VERIFY_TOKEN || "";
    this.appSecret = process.env.META_APP_SECRET || "";
    this.port = Number(process.env.INSTAGRAM_WEBHOOK_PORT || 8787);
    this.onMessage = null;
    this.server = null;
    this.seen = new Map(); // dedup of message ids (IG redelivers webhooks)
  }

  isAllowed(userId) {
    const list = String(process.env.INSTAGRAM_ALLOWED_USER_IDS || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    return list.includes(String(userId));
  }

  async start() {
    if (!this.enabled) {
      this.log("info", "instagram_disabled", { reason: "INSTAGRAM_ENABLED!=true ou credenciais ausentes" });
      return { disabled: true };
    }
    const missing = ["META_ACCESS_TOKEN", "INSTAGRAM_ACCOUNT_ID", "META_VERIFY_TOKEN"].filter(
      (k) => !process.env[k]
    );
    if (missing.length) throw new Error(`Instagram habilitado mas faltam envs: ${missing.join(", ")}`);

    const me = await fetch(`${GRAPH}/${this.accountId}?fields=username&access_token=${this.token}`)
      .then((r) => r.json());
    if (me.error) throw new Error(`Meta API: ${me.error.message}`);

    this.server = createServer((req, res) => this._handleWebhook(req, res));
    await new Promise((r) => this.server.listen(this.port, "127.0.0.1", r));
    this.log("info", "instagram_webhook_listening", { port: this.port, account: me.username });
    return { disabled: false, account: me.username };
  }

  async stop() {
    if (this.server) this.server.close();
  }

  _verifySignature(rawBody, header) {
    if (!this.appSecret || !header) return false;
    const sig = Buffer.from(header.replace("sha256=", ""), "hex");
    const mac = createHmac("sha256", this.appSecret).update(rawBody).digest();
    return sig.length === mac.length && timingSafeEqual(sig, mac);
  }

  _handleWebhook(req, res) {
    if (req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      if (url.searchParams.get("hub.verify_token") === this.verifyToken) {
        res.end(url.searchParams.get("hub.challenge"));
      } else {
        res.statusCode = 403;
        res.end();
      }
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        if (this.appSecret && !this._verifySignature(raw, req.headers["x-hub-signature-256"])) {
          res.statusCode = 403; res.end(); return;
        }
        res.end("EVENT_RECEIVED");
        const body = JSON.parse(raw);
        for (const entry of body.entry ?? []) {
          for (const evt of entry.messaging ?? []) {
            const text = evt.message?.text;
            const sender = evt.sender?.id;
            if (!text || !sender || evt.message.is_echo) continue;
            if (!this.isAllowed(sender)) continue;
            if (this._dup(evt.message.mid)) continue;
            this.onMessage?.({
              channel: "instagram",
              chatId: sender, // IG DMs: recipient id == user id
              userId: sender,
              username: sender,
              text,
              messageId: evt.message.mid,
              raw: evt,
            });
          }
        }
      } catch (e) {
        this.log("error", "instagram_webhook_error", { err: e.message });
        try { res.end(); } catch {}
      }
    });
  }

  _dup(mid) {
    const now = Date.now();
    for (const [k, t] of this.seen) if (now - t > 300_000) this.seen.delete(k);
    if (this.seen.has(mid)) return true;
    this.seen.set(mid, now);
    return false;
  }

  async sendTyping(chatId) {
    if (!this.enabled) return;
    await fetch(`${GRAPH}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: chatId },
        sender_action: "typing_on",
        access_token: this.token,
      }),
    }).catch(() => {});
  }

  async sendMessage(chatId, text, _extra) {
    if (!this.enabled) throw new Error("Instagram desabilitado");
    let t = text || "(sem saída)";
    while (t.length > 1000) {
      await this._send(t.slice(0, 1000), chatId);
      t = t.slice(1000);
    }
    return this._send(t, chatId);
  }

  async _send(text, chatId) {
    const r = await fetch(`${GRAPH}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: chatId }, message: { text }, access_token: this.token }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`IG send: ${j.error.message}`);
    return j;
  }

  async editMessage() { /* IG Direct API does not support editing */ }
}
