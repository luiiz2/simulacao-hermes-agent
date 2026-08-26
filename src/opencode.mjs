// Persistent OpenCode backend: supervises `opencode serve` and exposes a
// small async API on top of the official @opencode-ai/sdk. One long-running
// server, many sessions — never a new engine process per message.

import { createOpencodeClient } from "@opencode-ai/sdk";
import { spawn } from "node:child_process";

// Modelos por modo — configuráveis via .env para portar para qualquer setup:
// MODEL_AUTO=provider/model  MODEL_FAST=…  MODEL_CODE=…  MODEL_DEEP=…
export const MODELS = {
  auto: { id: process.env.MODEL_AUTO || "opencode/x-preview-f-free", label: "AUTO · padrão" },
  fast: { id: process.env.MODEL_FAST || "opencode/mimo-v2.5-free", label: "FAST · rápido" },
  code: { id: process.env.MODEL_CODE || "opencode/hy3-free", label: "CODE · código" },
  deep: { id: process.env.MODEL_DEEP || "opencode/nemotron-3-ultra-free", label: "DEEP · profundo" },
};

export function modelFor(chat) {
  if (chat.modelOverride) return chat.modelOverride;
  return (MODELS[chat.mode] || MODELS.auto).id;
}

export function parseModelId(id) {
  const i = id.indexOf("/");
  return i === -1 ? { providerID: "omniroute", modelID: id } : { providerID: id.slice(0, i), modelID: id.slice(i + 1) };
}

// Fallback chain: primary model first, then configured extras. Pure + testable.
export function buildFallbackChain(primary, extras) {
  const chain = [primary];
  for (const m of extras || []) if (m && !chain.includes(m)) chain.push(m);
  return chain;
}

export function extractText(result) {
  const parts = result?.parts ?? [];
  return parts.filter((p) => p.type === "text").map((p) => p.text).join("\n").trim();
}

export class OpencodeEngine {
  constructor({ baseUrl, username, password, workdir, log }) {
    this.baseUrl = baseUrl;
    this.workdir = workdir;
    this.log = log;
    this.proc = null;
    this.authHeader =
      "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    this.client = createOpencodeClient({
      baseUrl,
      fetch: (url, init = {}) =>
        globalThis.fetch(url, {
          ...init,
          headers: { ...init.headers, Authorization: this.authHeader },
        }),
    });
  }

  async healthy(timeoutMs = 4000) {
    try {
      const ctl = AbortSignal.timeout(timeoutMs);
      const r = await fetch(`${this.baseUrl}/global/health`, {
        headers: { Authorization: this.authHeader },
        signal: ctl,
      });
      if (!r.ok) return false;
      const j = await r.json();
      return !!j?.healthy;
    } catch {
      return false;
    }
  }

  // Start server in workdir if not already healthy.
  async ensureServer(workdir = this.workdir) {
    if (await this.healthy()) {
      if (workdir !== this.workdir) await this.restartServer(workdir);
      return;
    }
    await this._spawnServer(workdir);
  }

  async restartServer(workdir) {
    await this.stopServer().catch(() => {});
    await this._spawnServer(workdir);
  }

  async _spawnServer(workdir) {
    this.log("info", "opencode_server_start", { workdir });
    const exe = process.platform === "win32" ? "opencode.cmd" : "opencode";
    this.proc = spawn(exe, ["serve", "--port", "4096", "--hostname", "127.0.0.1"], {
      cwd: workdir,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD || "tgw-local",
        OPENCODE_SERVER_USERNAME: process.env.OPENCODE_SERVER_USERNAME || "opencode",
      },
    });
    this.proc.on("exit", (code) => this.log("warn", "opencode_server_exit", { code }));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (await this.healthy(2000)) {
        this.workdir = workdir;
        this.log("info", "opencode_server_ready", { ms: 90_000 - (deadline - Date.now()) });
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("opencode serve não ficou saudável em 90s");
  }

  async stopServer() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    p.kill();
    if (process.platform === "win32") {
      spawn("taskkill.exe", ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await this.healthy(1000))) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ---- session ops -----------------------------------------------------------

  async createSession(title) {
    const r = await this.client.session.create({ body: title ? { title } : {} });
    return r.data ?? r;
  }

  async listSessions() {
    const r = await this.client.session.list();
    return r.data ?? r;
  }

  async getSession(id) {
    const r = await this.client.session.get({ path: { id } });
    return r.data ?? r;
  }

  async updateSession(id, body) {
    const r = await this.client.session.update({ path: { id }, body });
    return r.data ?? r;
  }

  async abortSession(id) {
    try {
      await this.client.session.abort({ path: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async summarizeSession(id) {
    try {
      await this.client.session.summarize({ path: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async revertSession(id, messageID) {
    try {
      await this.client.session.revert({ path: { id }, body: { messageID } });
      return true;
    } catch {
      return false;
    }
  }

  async respondPermission(sessionID, permissionID, response) {
    try {
      await this.client.postSessionByIdPermissionsByPermissionId({
        path: { id: sessionID, permissionId: permissionID },
        body: { response },
      });
      return true;
    } catch (e) {
      this.log("error", "permission_respond_failed", { permissionID, err: e.message });
      return false;
    }
  }

  // Blocking prompt; resolves with final AssistantMessage. Streaming updates
  // arrive separately through subscribeEvents().
  async prompt(sessionID, text, chat) {
    const model = parseModelId(modelFor(chat));
    const t0 = Date.now();
    const r = await this.client.session.prompt({
      path: { id: sessionID },
      body: { model, parts: [{ type: "text", text }] },
    });
    this.log("info", "prompt_done", { sessionID, ms: Date.now() - t0 });
    const data = r.data ?? r;
    return data?.parts ? data : null;
  }

  // Prompt com fallback em cadeia: tenta o modelo principal; se falhar ou
  // vier vazio, desce a lista de fallbacks. Notifica via onFallback(modeloFalhou, proximo).
  async promptWithFallback(sessionID, text, chat, { extras = [], onFallback } = {}) {
    const chain = buildFallbackChain(modelFor(chat), extras);
    let lastErr = null;
    for (let i = 0; i < chain.length; i++) {
      const m = chain[i];
      try {
        const result = await this.prompt(sessionID, text, { ...chat, modelOverride: m });
        const t = extractText(result);
        if (t) return { text: t, model: m };
        lastErr = new Error(`modelo ${m} retornou vazio`);
      } catch (e) {
        lastErr = e;
      }
      if (i < chain.length - 1 && onFallback) {
        try { await onFallback(m, chain[i + 1]); } catch {}
      }
    }
    throw lastErr || new Error("nenhum modelo disponível");
  }

  // Subscribe once to the server SSE stream; cb(event) for every event.
  // Raw SSE reader — the SDK's event.subscribe() silently yields nothing on
  // this server build, so we parse text/event-stream ourselves.
  async subscribeEvents(cb) {
    for (;;) {
      try {
        const r = await fetch(`${this.baseUrl}/event`, {
          headers: { Authorization: this.authHeader, Accept: "text/event-stream" },
        });
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of r.body) {
          buf += decoder.decode(chunk, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const parsed = JSON.parse(payload);
              cb(parsed.type ? parsed : { type: parsed.type ?? "unknown", properties: parsed.properties ?? parsed });
            } catch {}
          }
        }
        this.log("warn", "event_stream_closed");
      } catch (e) {
        this.log("warn", "event_stream_lost", { err: e.message });
      }
      await new Promise((r2) => setTimeout(r2, 3000)); // reconnect backoff
    }
  }

  async providers() {
    try {
      const r = await this.client.config.providers();
      const d = r.data ?? r;
      const out = [];
      for (const p of d?.providers ?? []) {
        for (const m of p.models ?? []) out.push(`${p.id}/${m.id}`);
      }
      return out;
    } catch {
      return [];
    }
  }
}
