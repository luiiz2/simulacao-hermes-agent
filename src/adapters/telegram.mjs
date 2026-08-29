import { tmpdir } from "node:os";
import { extname, join, basename } from "node:path";
import { writeFileSync } from "node:fs";
import { mimeTypeForFile } from "../files.mjs";

const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export class TelegramAdapter {
  constructor({ token, allowedUserIds, log, initialOffset = 0, maxAttachmentBytes = DEFAULT_MAX_ATTACHMENT_BYTES }) {
    this.token = token;
    this.allowed = new Set(allowedUserIds.map(String));
    this.log = log;
    this.api = `https://api.telegram.org/bot${token}`;
    this.onMessage = null;
    this.onCallback = null;
    this.onOffset = null;
    this.offset = initialOffset;
    this.maxAttachmentBytes = maxAttachmentBytes;
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

  async downloadFile(fileId, outDir = tmpdir(), customName = null) {
    const info = await this._call("getFile", { file_id: fileId });
    if (!info?.file_path) throw new Error("Não foi possível obter caminho do arquivo do Telegram");
    const fileUrl = `https://api.telegram.org/file/bot${this.token}/${info.file_path}`;
    const r = await fetch(fileUrl, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`Falha no download do arquivo: HTTP ${r.status}`);
    const contentLength = Number(r.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > this.maxAttachmentBytes) {
      throw new Error(`Arquivo excede o limite de ${Math.round(this.maxAttachmentBytes / 1024 / 1024)} MB`);
    }
    const ext = extname(customName || info.file_path) || ".bin";
    const base = customName ? customName.replace(/[\\/]/g, "_") : `tg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    const dest = join(outDir, base);
    const buffer = Buffer.from(await r.arrayBuffer());
    if (buffer.length > this.maxAttachmentBytes) {
      throw new Error(`Arquivo excede o limite de ${Math.round(this.maxAttachmentBytes / 1024 / 1024)} MB`);
    }
    writeFileSync(dest, buffer);
    return dest;
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
        for (const u of updates) await this._processUpdate(u);
      } catch (e) {
        this.log("warn", "poll_error", { err: e.message, backoff });
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 8000);
      }
    }
  }

  async _processUpdate(u) {
    this.offset = u.update_id + 1;
    try {
      if (u.callback_query && this.onCallback) {
        await this.onCallback(this.normalizeCallback(u.callback_query));
      } else if (u.message) {
        if (u.message.photo?.length && this.onMessage) {
          const best = u.message.photo[u.message.photo.length - 1];
          let photoPath = null;
          try {
            photoPath = await this.downloadFile(best.file_id);
          } catch (err) {
            this.log("warn", "tg_photo_download_failed", { err: err.message });
          }
          await this.onMessage(this.normalizeMessage({
            ...u.message,
            text: u.message.caption || "",
            photoPath,
            fileMimeType: "image/jpeg",
            cleanupPaths: photoPath ? [photoPath] : [],
          }));
        } else if (u.message.document && this.onMessage) {
          const doc = u.message.document;
          let filePath = null;
          try {
            filePath = await this.downloadFile(doc.file_id, undefined, doc.file_name);
          } catch (err) {
            this.log("warn", "tg_doc_download_failed", { err: err.message });
          }
          await this.onMessage(this.normalizeMessage({
            ...u.message,
            text: u.message.caption || "",
            filePath,
            fileName: doc.file_name,
            fileMimeType: doc.mime_type || mimeTypeForFile(doc.file_name),
            cleanupPaths: filePath ? [filePath] : [],
          }));
        } else if ((u.message.voice || u.message.audio) && this.onMessage) {
          await this.sendMessage(
            String(u.message.chat.id),
            "🎤 Mensagens de voz ainda não são processadas. Envie em texto ou anexe arquivos/fotos."
          ).catch(() => {});
        } else if (u.message.text && this.onMessage) {
          await this.onMessage(this.normalizeMessage(u.message));
        }
      }
    } catch (e) {
      this.log("error", "update_handler_error", { err: e.message });
    } finally {
      try { this.onOffset?.(this.offset); } catch (e) {
        this.log("warn", "offset_persist_failed", { err: e.message });
      }
    }
  }

  normalizeMessage(m) {
    return {
      channel: "telegram",
      chatId: String(m.chat.id),
      userId: String(m.from.id),
      username: m.from.username || m.from.first_name || "",
      text: m.text || m.caption || "",
      photoPath: m.photoPath || null,
      filePath: m.filePath || null,
      fileName: m.fileName || null,
      fileMimeType: m.fileMimeType || null,
      cleanupPaths: Array.isArray(m.cleanupPaths) ? m.cleanupPaths : [],
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
    const parts = splitMessage(text, 4000);
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
    const r = await fetch(`${this.api}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`sendPhoto: ${j.description}`);
    return j.result;
  }

  async deleteMessage(chatId, messageId) {
    try { await this._call("deleteMessage", { chat_id: chatId, message_id: messageId }); } catch {}
  }
}

export function splitMessage(text, maxLen = 4000) {
  const content = String(text || "(sem saída)");
  if (content.length <= maxLen) return [content];
  const chunks = [];
  let remaining = content;

  while (remaining.length > maxLen) {
    // 1. Tenta quebrar em parágrafo duplo (\n\n)
    let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
    if (splitIdx < maxLen - 1200 || splitIdx === -1) {
      // 2. Tenta quebrar em linha simples (\n)
      splitIdx = remaining.lastIndexOf("\n", maxLen);
    }
    if (splitIdx < maxLen - 1200 || splitIdx === -1) {
      // 3. Tenta quebrar em espaço
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIdx < maxLen - 1200 || splitIdx === -1) {
      // 4. Corte rígido se não houver divisor próximo
      splitIdx = maxLen;
    }

    let chunk = remaining.slice(0, splitIdx);
    remaining = remaining.slice(splitIdx).replace(/^\n+/, "");

    // Tratamento de blocos de código Markdown (```)
    const codeBlocks = chunk.match(/```[a-zA-Z0-9_-]*/g) || [];
    const isInsideCodeBlock = codeBlocks.length % 2 !== 0;

    if (isInsideCodeBlock) {
      const lastFence = codeBlocks[codeBlocks.length - 1]; // ex: "```js" ou "```"
      chunk = `${chunk}\n\`\`\``;
      remaining = `${lastFence}\n${remaining}`;
    }

    chunks.push(chunk);
  }

  if (remaining.length) chunks.push(remaining);
  return chunks;
}
