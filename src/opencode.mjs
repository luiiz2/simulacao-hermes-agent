// Persistent OpenCode backend: supervises `opencode serve` and exposes a
// small async API on top of the official @opencode-ai/sdk. One long-running
// server, many sessions — never a new engine process per message.

import { createOpencodeClient } from "@opencode-ai/sdk";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import "./config.mjs";
import { mimeTypeForFile } from "./files.mjs";

// Modelos por modo — configuráveis via .env para portar para qualquer setup:
// MODEL_AUTO=provider/model  MODEL_FAST=…  MODEL_CODE=…  MODEL_DEEP=…
export const MODELS = {
  auto: { id: process.env.MODEL_AUTO || "opencode/x-preview-f-free", label: "AUTO · padrão" },
  fast: { id: process.env.MODEL_FAST || "opencode/mimo-v2.5-free", label: "FAST · rápido" },
  code: { id: process.env.MODEL_CODE || "opencode/hy3-free", label: "CODE · código" },
  deep: { id: process.env.MODEL_DEEP || "opencode/nemotron-3-ultra-free", label: "DEEP · profundo" },
};

export function parseServerEndpoint(baseUrl) {
  const url = new URL(String(baseUrl || "http://127.0.0.1:4096"));
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("OPENCODE_SERVER_URL deve usar http:// ou https://");
  }
  const defaultPort = url.protocol === "https:" ? "443" : "4096";
  return {
    baseUrl: url.toString().replace(/\/$/, ""),
    hostname: url.hostname,
    port: url.port || defaultPort,
    protocol: url.protocol,
  };
}

function isLocalEndpoint(endpoint) {
  return endpoint.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(endpoint.hostname);
}

export function modelFor(chat) {
  if (chat.modelOverride) return chat.modelOverride;
  return MODELS[chat?.mode]?.id || null;
}

export function parseModelId(id) {
  const value = String(id || "").trim();
  if (!value) throw new Error("modelo não escolhido; use /model");
  const i = value.indexOf("/");
  return i === -1 ? { providerID: "omniroute", modelID: value } : { providerID: value.slice(0, i), modelID: value.slice(i + 1) };
}

function qualifyProviderModel(providerID, rawModelID) {
  const modelID = String(rawModelID || "").trim();
  if (!modelID) return null;
  return modelID.startsWith(`${providerID}/`) ? modelID : `${providerID}/${modelID}`;
}

export function providerModelSpecs(providers = []) {
  const out = [];
  for (const provider of providers || []) {
    const providerID = String(provider?.id || "").trim();
    if (!providerID) continue;
    const models = provider.models;
    let added = false;
    const add = (rawModelID) => {
      const modelID = String(rawModelID || "").trim();
      const id = qualifyProviderModel(providerID, modelID);
      if (!id) return;
      out.push({ id, providerID, modelID });
      added = true;
    };
    if (Array.isArray(models)) {
      for (const model of models) {
        const raw = typeof model === "string" ? model : model?.id;
        add(raw);
      }
    } else if (models && typeof models === "object") {
      for (const [key, model] of Object.entries(models)) {
        const raw = typeof model === "string" ? model : model?.id || key;
        add(raw);
      }
    }
    if (!added) out.push({ id: providerID, providerID, modelID: providerID });
  }
  const seen = new Set();
  return out.filter((spec) => {
    if (seen.has(spec.id)) return false;
    seen.add(spec.id);
    return true;
  });
}

export function providerModelIds(providers = []) {
  return providerModelSpecs(providers).map((spec) => spec.id);
}

export function resolveModelId(id, providers = []) {
  const value = String(id || "").trim();
  const known = providerModelSpecs(providers).find((spec) => spec.id === value);
  return known
    ? { providerID: known.providerID, modelID: known.modelID }
    : parseModelId(value);
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

function promptResponseError(response) {
  const error = response?.error;
  if (!error) return null;
  const message = error.data?.message || error.message ||
    `OpenCode retornou HTTP ${response.response?.status || "desconhecido"}`;
  return new Error(String(message));
}

function homeFor(env) {
  return env.USERPROFILE || env.HOME || homedir();
}

function globalConfigDirFor(env) {
  return join(env.XDG_CONFIG_HOME || join(homeFor(env), ".config"), "opencode");
}

function globalConfigFileFor(dir) {
  for (const name of ["opencode.jsonc", "opencode.json", "config.json"]) {
    const file = join(dir, name);
    if (existsSync(file)) return file;
  }
  return undefined;
}

// OpenCode's Windows/Bun builds can abort when the normal global config
// directory already exists. Keep the real data directory (auth/history), but
// give the headless server a stable config home and explicitly load the user's
// existing config from its original location.
export function buildOpenCodeSpawnEnv(input = process.env, platform = process.platform) {
  const env = { ...input };
  if (platform !== "win32" || env.GATEWAY_OPENCODE_HEADLESS_CONFIG === "false") return env;

  const sourceDir = env.OPENCODE_CONFIG_DIR || globalConfigDirFor(env);
  const runtimeBase = env.GATEWAY_OPENCODE_CONFIG_HOME || join(
    env.LOCALAPPDATA || join(homeFor(env), "AppData", "Local"),
    "AgentGateway",
    "opencode-config",
  );

  env.XDG_CONFIG_HOME = runtimeBase;
  if (!env.OPENCODE_CONFIG) {
    const file = globalConfigFileFor(sourceDir);
    if (file) env.OPENCODE_CONFIG = file;
  }
  if (!env.OPENCODE_CONFIG_DIR && existsSync(sourceDir)) env.OPENCODE_CONFIG_DIR = sourceDir;
  return env;
}

export class OpencodeEngine {
  constructor({ baseUrl, username, password, workdir, log }) {
    this.endpoint = parseServerEndpoint(baseUrl);
    this.baseUrl = this.endpoint.baseUrl;
    this.workdir = workdir;
    this.log = log;
    this.proc = null;
    this.lifecycle = Promise.resolve();
    this.providerSpecs = [];
    this.providerSpecsAt = 0;
    this.authHeader =
      "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    this.client = createOpencodeClient({
      baseUrl: this.baseUrl,
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
  _queueLifecycle(task) {
    const next = this.lifecycle.then(task, task);
    this.lifecycle = next.catch(() => {});
    return next;
  }

  async ensureServer(workdir = this.workdir) {
    return this._queueLifecycle(async () => {
      if (await this.healthy()) {
        if (workdir !== this.workdir) await this._restartServer(workdir);
        return;
      }
      await this._spawnServer(workdir);
    });
  }

  async restartServer(workdir) {
    return this._queueLifecycle(() => this._restartServer(workdir));
  }

  async _restartServer(workdir) {
    await this.stopServer().catch(() => {});
    await this._spawnServer(workdir);
  }

  async _spawnServer(workdir) {
    if (!isLocalEndpoint(this.endpoint)) {
      throw new Error("Servidor OpenCode remoto indisponível; não será iniciado localmente.");
    }
    this.log("info", "opencode_server_start", { workdir });
    const exe = process.platform === "win32" ? "opencode.cmd" : "opencode";
    this.proc = spawn(exe, ["serve", "--port", this.endpoint.port, "--hostname", this.endpoint.hostname], {
      cwd: workdir,
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: "ignore",
      env: {
        ...buildOpenCodeSpawnEnv(process.env),
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

  async diffSession(id) {
    try {
      const r = await this.client.session.diff({ path: { id } });
      return r.data ?? r;
    } catch {
      return null;
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
      await this.client.postSessionIdPermissionsPermissionId({
        path: { id: sessionID, permissionID },
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
  async prompt(sessionID, text, chat, options = {}) {
    const model = await this.resolveModel(modelFor(chat));
    const t0 = Date.now();
    const parts = [{ type: "text", text: String(text || "") }];
    const attachmentPath = options?.filePath || options?.photoPath;
    if (attachmentPath) {
      try {
        const { pathToFileURL } = await import("node:url");
        parts.push({
          type: "file",
          mime: options.mimeType || mimeTypeForFile(options.fileName || attachmentPath),
          filename: options.fileName || basename(attachmentPath),
          url: pathToFileURL(attachmentPath).href,
        });
      } catch {}
    }
    const timeoutMs = Number(process.env.MODEL_TIMEOUT_MS || 25_000);
    const r = await this.client.session.prompt({
      path: { id: sessionID },
      body: { model, parts },
      signal: AbortSignal.timeout(timeoutMs),
    });
    this.log("info", "prompt_done", { sessionID, ms: Date.now() - t0 });
    const failure = promptResponseError(r);
    if (failure) throw failure;
    const data = r.data ?? r;
    if (!data?.parts) throw new Error("OpenCode não retornou uma resposta válida");
    return data;
  }

  // Prompt com fallback em cadeia: tenta o modelo principal; se falhar ou
  // vier vazio, desce a lista de fallbacks. Notifica via onFallback(modeloFalhou, proximo).
  async promptWithFallback(sessionID, text, chat, {
    extras = [], onFallback, photoPath, filePath, fileName, mimeType,
  } = {}) {
    const chain = buildFallbackChain(modelFor(chat), extras);
    let lastErr = null;
    for (let i = 0; i < chain.length; i++) {
      const m = chain[i];
      try {
        const result = await this.prompt(sessionID, text, { ...chat, modelOverride: m }, {
          photoPath, filePath, fileName, mimeType,
        });
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

  async loadProviderSpecs(force = false) {
    const fresh = this.providerSpecsAt && Date.now() - this.providerSpecsAt < 10 * 60_000;
    if (!force && fresh) return this.providerSpecs;
    const r = await this.client.config.providers();
    const d = r.data ?? r;
    this.providerSpecs = providerModelSpecs(d?.providers ?? []);
    this.providerSpecsAt = Date.now();
    return this.providerSpecs;
  }

  async resolveModel(id) {
    const value = String(id || "").trim();
    let spec = this.providerSpecs.find((item) => item.id === value);
    if (!spec || !this.providerSpecsAt || Date.now() - this.providerSpecsAt >= 10 * 60_000) {
      try {
        spec = (await this.loadProviderSpecs()).find((item) => item.id === value);
      } catch {}
    }
    return spec
      ? { providerID: spec.providerID, modelID: spec.modelID }
      : parseModelId(value);
  }

  async providers() {
    try {
      return (await this.loadProviderSpecs()).map((spec) => spec.id);
    } catch {
      return [];
    }
  }
}
