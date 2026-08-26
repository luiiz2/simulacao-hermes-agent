// Agent Gateway — Telegram (+Instagram ready) → CommandRouter → OpenCode.
// OpenCode stays the agent; this is only the remote interface layer.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { log, setDebug } from "./logger.mjs";
import { sanitizeForChat } from "./sanitize.mjs";
import { SessionStore } from "./sessionStore.mjs";
import { OpencodeEngine, MODELS, modelFor } from "./opencode.mjs";
import { ComputerActions } from "./computer.mjs";
import { bindHandlers, resolve, menuForBot, helpText } from "./commandRegistry.mjs";
import { TelegramAdapter } from "./adapters/telegram.mjs";
import { InstagramAdapter } from "./adapters/instagram.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(process.env.GATEWAY_WORKDIR || ROOT);

// ---------- .env ----------
try {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const CFG = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  allowedUsers: String(process.env.TELEGRAM_ALLOWED_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
  defaultWorkspace: process.env.DEFAULT_WORKSPACE || process.cwd(),
  serverUrl: process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096",
  serverUser: process.env.OPENCODE_SERVER_USERNAME || "opencode",
  serverPass: process.env.OPENCODE_SERVER_PASSWORD || "tgw-local",
};

if (!CFG.telegramToken) { console.error("TELEGRAM_BOT_TOKEN ausente no .env"); process.exit(1); }
if (!CFG.allowedUsers.length) console.error("AVISO: TELEGRAM_ALLOWED_USER_IDS vazio — ninguém será autorizado.");

// ---------- single instance ----------
const LOCK = join(ROOT, "gateway.lock");
if (existsSync(LOCK)) {
  try {
    const pid = Number(readFileSync(LOCK, "utf8").trim());
    process.kill(pid, 0);
    console.error(`gateway já rodando (pid ${pid}); saindo`);
    process.exit(0);
  } catch {}
}
writeFileSync(LOCK, String(process.pid));
setDebug(process.env.GATEWAY_DEBUG === "true");

// ---------- core ----------
const store = new SessionStore(join(ROOT, "state.json"));
const computer = new ComputerActions(log);
const engine = new OpencodeEngine({
  baseUrl: CFG.serverUrl,
  username: CFG.serverUser,
  password: CFG.serverPass,
  workdir: CFG.defaultWorkspace,
  log,
});

const telegram = new TelegramAdapter({
  token: CFG.telegramToken,
  allowedUserIds: CFG.allowedUsers,
  log,
  initialOffset: Number(store.data.telegramOffset || 0),
});
telegram.onOffset = (o) => {
  store.data.telegramOffset = o;
  store.save();
};
const instagram = new InstagramAdapter({ log });
const adapters = [telegram, instagram];

let DEBUG = false;
const streams = new Map();      // opencode sessionID -> live stream state
const sessionChats = new Map(); // sessionID -> chatId (for permission prompts)
const pendingPerms = new Map(); // permID -> {sessionID, chatId}
const recentHashes = new Map(); // dedup window

// ---------- small helpers ----------
const chatKey = (m) => `${m.channel}:${m.userId}`;

function isAuthed(m) {
  return m.channel === "telegram" ? telegram.isAllowed(m.userId) : instagram.isAllowed(m.userId);
}

function isDup(m) {
  let h = 5381;
  for (const c of chatKey(m) + m.text) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  const k = String(h);
  const now = Date.now();
  for (const [kk, t] of recentHashes) if (now - t > 60_000) recentHashes.delete(kk);
  if (recentHashes.has(k)) return true;
  recentHashes.set(k, now);
  return false;
}

function replyFn(m) {
  return async (text, extra = {}) => {
    if (m.channel === "telegram") return telegram.sendMessage(m.chatId, sanitizeForChat(text), extra);
    return instagram.sendMessage(m.chatId, sanitizeForChat(text));
  };
}

function makeCtx(m, chat, args = "") {
  return { channel: m.channel, userId: m.userId, chatId: m.chatId, msg: m, chat, args, reply: replyFn(m) };
}

// ---------- AI flow ----------
async function aiFlow(m, chat, promptText) {
  const t0 = Date.now();
  log("info", "ai_start", { channel: m.channel, user: m.userId, len: promptText.length });
  await ensureServerMatches(chat);

  const session = await ensureSession(m, chat);
  store.updateChat(m.channel, m.userId, { lastPrompt: promptText });
  sessionChats.set(session.id, m.chatId);

  const typing = setInterval(() => {
    if (m.channel === "telegram") telegram.sendTyping(m.chatId);
  }, 4000);
  if (m.channel === "telegram") telegram.sendTyping(m.chatId).catch(() => {});

  let placeholder = null;
  try { placeholder = await telegram.sendMessage(m.chatId, "…"); } catch {}
  if (placeholder) {
    streams.set(session.id, {
      chatId: m.chatId, text: "", messageId: placeholder.message_id, lastEdit: Date.now(), done: false,
    });
  }

  const modelId = modelFor(chat);
  const fallbacks = String(process.env.MODEL_FALLBACKS || "opencode/x-preview-f-free,omniroute/auto/best-coding")
    .split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const { text: finalRaw } = await engine.promptWithFallback(session.id, promptText, chat, {
      extras: fallbacks,
      onFallback: async (failedModel, nextModel) => {
        log("warn", "model_fallback", { failed: failedModel, next: nextModel });
        await telegram.sendMessage(m.chatId, `⚠️ \`${failedModel}\` falhou — tentando \`${nextModel}\`…`);
      },
    });
    const clean = sanitizeForChat(finalRaw).trim() ||
      "⚠️ Nenhum modelo conseguiu responder agora. Use /retry em alguns instantes.";
    log("info", "ai_done", { ms: Date.now() - t0, chars: clean.length });
    if (placeholder?.message_id) {
      const ok = await telegram.editMessage(m.chatId, placeholder.message_id, clean).then(() => true).catch(() => false);
      if (!ok) await telegram.sendMessage(m.chatId, clean).catch(() => {});
    } else {
      await telegram.sendMessage(m.chatId, clean).catch(() => {});
    }
    return clean;
  } catch (e) {
    log("error", "ai_failed", { err: e.message, ms: Date.now() - t0 });
    const msg = `❌ Erro no agente: ${sanitizeForChat(e.message).slice(0, 500)}`;
    if (placeholder?.message_id) await telegram.editMessage(m.chatId, placeholder.message_id, msg).catch(() => {});
    else await telegram.sendMessage(m.chatId, msg).catch(() => {});
    throw e;
  } finally {
    clearInterval(typing);
    if (streams.has(session.id)) streams.delete(session.id);
  }
}

function extractAssistantText(result) {
  const parts = result?.parts ?? [];
  return parts.filter((p) => p.type === "text").map((p) => p.text).join("\n").trim();
}

// Sessão é "sticky": nunca troca silenciosamente. Só /new (ou /project, que
// muda o workspace) cria outra. Se a sessão sumir do servidor, tenta recuperar
// a última com a nossa etiqueta antes de criar uma nova.
async function ensureSession(m, chat) {
  const tag = `[${m.channel.slice(0, 2)}:${m.userId}]`;
  if (chat.sessionId) {
    let s = await engine.getSession(chat.sessionId).catch(() => null);
    if (!s) {
      await new Promise((r) => setTimeout(r, 1500)); // servidor aquecendo
      s = await engine.getSession(chat.sessionId).catch(() => null);
    }
    if (s) return s;
    log("warn", "session_lost", { id: chat.sessionId });

    // recuperação: última sessão nossa por título
    try {
      const all = (await engine.listSessions()) ?? [];
      const mine = all
        .filter((x) => x.title?.startsWith(tag))
        .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
      if (mine[0]) {
        store.updateChat(m.channel, m.userId, { sessionId: mine[0].id });
        sessionChats.set(mine[0].id, m.chatId);
        await telegram.sendMessage(m.chatId, `♻️ Sessão anterior recuperada: ${sanitizeForChat(mine[0].title || "").replace(tag, "").trim() || mine[0].id}`);
        log("info", "session_recovered", { id: mine[0].id });
        return mine[0];
      }
    } catch {}
  }
  const created = await engine.createSession(`${tag} ${(chat.workspace.split(/[\\/]/).pop() || "proj")}`);
  store.updateChat(m.channel, m.userId, { sessionId: created.id });
  await telegram.sendMessage(m.chatId, `🆕 Nova sessão criada (\`${created.id.slice(0, 12)}…\`).`).catch(() => {});
  log("info", "session_created", { id: created.id });
  return created;
}

async function ensureServerMatches(chat) {
  const norm = (p) => String(p).replace(/[\\/]+$/, "").toLowerCase();
  if (norm(engine.workdir) !== norm(chat.workspace)) {
    await engine.restartServer(chat.workspace);
  } else if (!(await engine.healthy())) {
    await engine.ensureServer(chat.workspace);
  }
}

// ---------- SSE events ----------
engine.subscribeEvents(async (ev) => {
  const type = ev?.type || "";
  const props = ev?.properties ?? {};
  if (type === "message.part.updated") {
    const part = props.part ?? {};
    const sid = props.sessionID ?? part.sessionID;
    const st = streams.get(sid);
    if (!st || st.done) return;
    // user-echo parts carry numeric `time`; assistant parts carry {start,end}
    const isAssistant = part.type === "text" && part.time && typeof part.time === "object";
    if (!isAssistant) return;
    if (typeof part.text === "string") st.text = part.text;
    if (part.time.end) st.done = true;
    const now = Date.now();
    if (st.messageId && st.text && (st.done || now - st.lastEdit > 700)) {
      st.lastEdit = now;
      telegram.editMessage(st.chatId, st.messageId, sanitizeForChat(st.text)).catch(() => {});
      if (st.done) streams.delete(sid);
    }
  } else if (/permission/i.test(type)) {
    const id = props.permissionID ?? props.id ?? props.requestID;
    const sid = props.sessionID;
    const chatId = sid ? sessionChats.get(sid) : null;
    if (!id || !chatId) return;
    pendingPerms.set(String(id), { sessionID: sid, chatId, ts: Date.now() });
    await telegram.sendMessage(
      chatId,
      `⚠️ Confirmação necessária\nAção: ${sanitizeForChat(props.title || props.action || type)}\n\n/approve ${id}\nou /deny ${id}`
    ).catch(() => {});
  }
});

// ---------- command handlers ----------
function setMode(mode) {
  return async (ctx) => {
    store.updateChat(ctx.channel, ctx.userId, { mode, modelOverride: null });
    await ctx.reply(`⚙️ Modo ${MODELS[mode].label}`);
  };
}

const HANDLERS = {
  new: async (ctx) => {
    const fresh = store.resetSession(ctx.channel, ctx.userId, true);
    await ctx.reply(`🆕 Nova conversa iniciada.\nProjeto mantido: \`${fresh.workspace}\``);
  },
  sessions: async (ctx) => {
    const all = (await engine.listSessions()) ?? [];
    const mine = all.filter((s) => s.title?.startsWith(`[${ctx.channel.slice(0, 2)}:${ctx.userId}]`) || s.title?.startsWith("[tg:"));
    const lines = mine.slice(-10).reverse().map((s) =>
      `\`${s.id}\` — ${sanitizeForChat((s.title || "").replace(/^\[[^\]]+\]\s*/, ""))}${s.id === ctx.chat.sessionId ? " ← atual" : ""}`);
    await ctx.reply(lines.length ? `📂 Conversas:\n${lines.join("\n")}` : "Nenhuma conversa anterior.");
  },
  resume: async (ctx) => {
    const id = ctx.args.trim().replace(/`/g, "");
    if (!id) return ctx.reply("Uso: /resume <id>");
    const s = await engine.getSession(id).catch(() => null);
    if (!s) return ctx.reply("Sessão não encontrada.");
    store.updateChat(ctx.channel, ctx.userId, { sessionId: s.id });
    await ctx.reply(`▶️ Retomada: ${sanitizeForChat(s.title || s.id)}`);
  },
  title: async (ctx) => {
    if (!ctx.args.trim()) return ctx.reply(`Título atual: ${ctx.chat.title || "(sem)"}`);
    const name = ctx.args.trim().slice(0, 60);
    if (ctx.chat.sessionId) await engine.updateSession(ctx.chat.sessionId, { title: `[${ctx.channel.slice(0, 2)}:${ctx.userId}] ${name}` }).catch(() => {});
    store.updateChat(ctx.channel, ctx.userId, { title: name });
    await ctx.reply(`🏷️ Título: ${name}`);
  },
  retry: async (ctx) => {
    if (!ctx.chat.lastPrompt) return ctx.reply("Nada para reenviar.");
    await aiFlow(ctx.msg, ctx.chat, ctx.chat.lastPrompt);
  },
  undo: async (ctx) => {
    if (!ctx.chat.sessionId) return ctx.reply("Sem conversa ativa.");
    try {
      const msgs = (await engine.client.session.messages({ path: { id: ctx.chat.sessionId } })).data ?? [];
      const lastUser = [...msgs].reverse().find((x) => x.info?.role === "user");
      if (!lastUser) return ctx.reply("Nada para desfazer.");
      await engine.revertSession(ctx.chat.sessionId, lastUser.info.id);
      await ctx.reply("↩️ Última troca removida do contexto.");
    } catch (e) {
      await ctx.reply(`Undo indisponível nesta versão: ${e.message.slice(0, 120)}`);
    }
  },
  compress: async (ctx) => {
    if (!ctx.chat.sessionId) return ctx.reply("Sem conversa ativa.");
    const ok = await engine.summarizeSession(ctx.chat.sessionId);
    await ctx.reply(ok ? "🗜️ Contexto comprimido." : "Compressão falhou.");
  },
  background: async (ctx) => {
    if (!ctx.args.trim()) return ctx.reply("Uso: /background <tarefa>");
    const session = await engine.createSession(`[bg] ${ctx.args.trim().slice(0, 50)}`);
    sessionChats.set(session.id, ctx.chatId);
    await ctx.reply(`🔄 Background iniciado (\`${session.id}\`). Aviso quando terminar.`);
    aiFlowBackground(ctx, session, ctx.args.trim());
  },
  stop: async (ctx) => {
    if (!ctx.chat.sessionId) return ctx.reply("Nada em execução.");
    const ok = await engine.abortSession(ctx.chat.sessionId);
    await ctx.reply(ok ? "🛑 Tarefa cancelada." : "Não havia tarefa rodando.");
  },

  model: async (ctx) => {
    const current = ctx.chat.modelOverride || modelFor(ctx.chat);
    if (!ctx.args.trim()) {
      const modes = Object.entries(MODELS)
        .map(([k, v]) => `${k === ctx.chat.mode && !ctx.chat.modelOverride ? "●" : "○"} ${v.label}`).join("\n");
      return ctx.reply(
        `🧠 Modelo atual: \`${current}\`\nModo: ${ctx.chat.mode.toUpperCase()}${ctx.chat.modelOverride ? " (override manual)" : ""}\n\nModos:\n${modes}\n\nTrocar modo: /auto · /fast · /code · /deep\nFixar modelo exato: /model <provider/model>`
      );
    }
    const wanted = ctx.args.trim();
    const known = await engine.providers();
    if (known.length && !known.includes(wanted)) return ctx.reply(`Modelo desconhecido: \`${wanted}\`. Exemplos válidos:\n${known.filter((k) => k.startsWith("auto/")).slice(0, 8).map((k) => `\`${k}\``).join("\n")}`);
    store.updateChat(ctx.channel, ctx.userId, { modelOverride: wanted });
    await ctx.reply(`🧠 Modelo fixado: \`${wanted}\`\nUse /auto para voltar ao automático.`);
  },
  auto: setMode("auto"),
  fast: setMode("fast"),
  code: setMode("code"),
  deep: setMode("deep"),

  project: async (ctx) => {
    if (!ctx.args.trim()) {
      const lines = [`📁 Projeto ativo: \`${ctx.chat.workspace}\``, "", "Recentes:"];
      store.data.projects.forEach((p, i) => lines.push(`${i + 1}. ${p}${p === ctx.chat.workspace ? " ←" : ""}`));
      lines.push("", "Trocar: /project <caminho completo da pasta>");
      return ctx.reply(lines.join("\n"));
    }
    const dir = ctx.args.trim().replace(/^"|"$/g, "");
    if (!existsSync(dir)) return ctx.reply(`Pasta não existe: ${dir}`);
    await engine.restartServer(dir);
    store.touchProject(dir);
    store.resetSession(ctx.channel, ctx.userId, false);
    const fresh = store.getChat(ctx.channel, ctx.userId, dir);
    fresh.workspace = dir;
    store.save();
    await ctx.reply(`📁 Projeto alterado para \`${dir}\`. Nova conversa criada nele.`);
  },
  status: async (ctx) => {
    const healthy = await engine.healthy();
    const busy = [...streams.values()].some((s) => !s.done);
    const lines = [
      `${healthy ? "🟢" : "🔴"} Agent ${healthy ? "online" : "offline"}`,
      `Projeto: \`${ctx.chat.workspace}\``,
      `Mode: ${ctx.chat.mode.toUpperCase()}`,
      `Modelo: \`${modelFor(ctx.chat)}\``,
      `Session: \`${ctx.chat.sessionId || "—"}\``,
      `Task: ${busy ? "executando" : "idle"}`,
      `Gateway: online`,
    ];
    if (DEBUG) lines.push(`Uptime: ${Math.round(process.uptime())}s · Chats: ${Object.keys(store.data.chats).length}`);
    await ctx.reply(lines.join("\n"));
  },
  whoami: async (ctx) => {
    const admin = CFG.allowedUsers[0] === ctx.userId;
    await ctx.reply(`Você: \`${ctx.userId}\` (${ctx.channel})\nAcesso: ${admin ? "admin" : "user"}`);
  },
  platform: async (ctx) => {
    const lines = adapters.map((a) => `${a.name}: ${a.enabled === false ? "⚪ disabled" : a.running === false ? "🔴 stopped" : "🟢 on"}`);
    await ctx.reply(lines.join("\n"));
  },

  sys: sensitiveCmd("sys"),
  ps: sensitiveCmd("ps_list"),
  open: sensitiveCmd("open"),
  url: sensitiveCmd("url"),
  shutdown: sensitiveCmd("shutdown"),
  restart: sensitiveCmd("restart"),
  shot: async (ctx) => {
    const r = await computer.run(ctx.userId, "shot");
    if (r.result?.screenshotPath) {
      try {
        await telegram.sendPhoto(ctx.chatId, r.result.screenshotPath, "📸 Captura de tela");
        return;
      } catch (e) { return ctx.reply(`Falha ao enviar print: ${e.message.slice(0, 150)}`); }
    }
    await ctx.reply("Falha na captura.");
  },
  confirm: async (ctx) => {
    const r = await computer.confirm(ctx.userId, ctx.args.trim());
    if (r.error) return ctx.reply(`❌ ${r.error}`);
    await ctx.reply(`✅ Executado.\n${String(r.result).slice(0, 300)}`);
  },
  approve: permCmd("allow"),
  deny: permCmd("deny"),

  debug: async (ctx) => {
    DEBUG = !DEBUG;
    setDebug(DEBUG);
    await ctx.reply(`🔧 Debug ${DEBUG ? "ON" : "OFF"}`);
  },
  help: async (ctx) => ctx.reply(helpText()),
  commands: async (ctx) => ctx.reply(helpText()),
};

function sensitiveCmd(action) {
  return async (ctx) => {
    const args = action === "open" || action === "url" ? [ctx.args.trim()] : [];
    try {
      if ((action === "open" || action === "url") && !args[0])
        return ctx.reply(`Uso: /${action} <${action === "open" ? "app" : "link"}>`);
      const r = await computer.run(ctx.userId, action, args);
      if (r.confirm) {
        return ctx.reply(`⚠️ Confirmação necessária\nAção: ${r.desc}\n\nResponda:\n/confirm ${r.confirm}\n(válido por 5 min, uso único)`);
      }
      if (r.ok) return ctx.reply(String(typeof r.result === "string" ? r.result : JSON.stringify(r.result)).slice(0, 1500));
      return ctx.reply(`Erro: ${r.error}`);
    } catch (e) {
      return ctx.reply(`❌ ${sanitizeForChat(e.message).slice(0, 300)}`);
    }
  };
}

function permCmd(response) {
  return async (ctx) => {
    const id = ctx.args.trim();
    const p = pendingPerms.get(id);
    if (!p) return ctx.reply("Nenhuma permissão pendente com esse id.");
    if (Date.now() - p.ts > 30 * 60_000) {
      pendingPerms.delete(id);
      return ctx.reply("Permissão expirada (>30 min). Peça a ação novamente.");
    }
    pendingPerms.delete(id);
    const ok = await engine.respondPermission(p.sessionID, id, response);
    await ctx.reply(ok ? (response === "allow" ? "✅ Aprovada." : "🚫 Negada.") : "Falha ao responder permissão.");
  };
}

async function aiFlowBackground(ctx, session, prompt) {
  try {
    await engine.prompt(session.id, prompt, ctx.chat);
    const msgs = (await engine.client.session.messages({ path: { id: session.id } })).data ?? [];
    const last = msgs[msgs.length - 1];
    const text = sanitizeForChat(extractAssistantText(last) || "(concluído sem texto)");
    await telegram.sendMessage(ctx.chatId, `✅ Background concluído (\`${session.id}\`):\n\n${text.slice(0, 3500)}`);
  } catch (e) {
    await telegram.sendMessage(ctx.chatId, `❌ Background falhou: ${sanitizeForChat(e.message).slice(0, 300)}`).catch(() => {});
  }
}

bindHandlers(HANDLERS);

// ---------- router ----------
async function handleMessage(m) {
  const t0 = Date.now();
  if (!isAuthed(m)) {
    log("warn", "unauthorized_ignored", { channel: m.channel, user: m.userId });
    if (m.channel === "telegram")
      telegram.sendMessage(m.chatId, "🔒 Não autorizado.").catch(() => {});
    return;
  }
  if (isDup(m)) { log("info", "dup_dropped", { user: m.userId }); return; }

  const text = m.text.trim();
  const chat = store.getChat(m.channel, m.userId, CFG.defaultWorkspace);
  if (!chat.workspace) { chat.workspace = CFG.defaultWorkspace; store.save(); }
  if (!store.data.projects.includes(chat.workspace)) store.touchProject(chat.workspace);

  if (text.startsWith("/")) {
    const sp = text.indexOf(" ");
    const cmdName = (sp === -1 ? text : text.slice(0, sp)).toLowerCase();
    const args = sp === -1 ? "" : text.slice(sp + 1).trim();
    const hit = resolve(cmdName);
    if (!hit) { await replyFn(m)(`Comando desconhecido: ${cmdName}. Use /help.`); return; }
    if (hit.handler) {
      log("info", "command", { cmd: hit.def.name, user: m.userId });
      await hit.handler(makeCtx(m, chat, args));
      log("info", "command_done", { cmd: hit.def.name, ms: Date.now() - t0 });
      return;
    }
  }

  await aiFlow(m, chat, text);
}

// ---------- callbacks ----------
telegram.onCallback = async (c) => {
  telegram.answerCallback(c.callbackId).catch(() => {});
  const [kind, a, b] = c.data.split(":");
  if (kind === "mode") {
    store.updateChat(c.channel, c.userId, { mode: a, modelOverride: null });
    telegram.sendMessage(c.chatId, `⚙️ Modo ${MODELS[a]?.label ?? a}`).catch(() => {});
  } else if (kind === "proj") {
    const dir = store.data.projects[Number(a)];
    if (!dir) return;
    await engine.restartServer(dir);
    store.resetSession(c.channel, c.userId, false);
    const fresh = store.getChat(c.channel, c.userId, dir);
    fresh.workspace = dir;
    store.save();
    telegram.sendMessage(c.chatId, `📁 Projeto: \`${dir}\``).catch(() => {});
  } else if (kind === "perm") {
    const p = pendingPerms.get(a);
    if (!p) { telegram.sendMessage(c.chatId, "Permissão expirada."); return; }
    pendingPerms.delete(a);
    const ok = await engine.respondPermission(p.sessionID, a, b === "y" ? "allow" : "deny");
    telegram.sendMessage(c.chatId, ok ? (b === "y" ? "✅ Aprovada." : "🚫 Negada.") : "Falha.").catch(() => {});
  }
};

telegram.onMessage = (m) => handleMessage(m).catch((e) => log("error", "tg_handle_error", { err: e.stack }));
instagram.onMessage = (m) => handleMessage(m).catch((e) => log("error", "ig_handle_error", { err: e.stack }));

// ---------- lifecycle ----------
async function start() {
  log("info", "gateway_start", { pid: process.pid, workspace: CFG.defaultWorkspace });
  await engine.ensureServer(CFG.defaultWorkspace);
  const tgInfo = await telegram.start();

  try {
    await instagram.start();
  } catch (e) {
    log("error", "instagram_start_failed_isolated", { err: e.message });
  }

  const refreshMenu = () => telegram.registerMenu(menuForBot(60)).catch((e) => log("warn", "menu_failed", { err: e.message }));
  await refreshMenu();
  setInterval(refreshMenu, 3_600_000).unref();

  console.log(`✅ Gateway online — @${tgInfo.username} | projeto: ${CFG.defaultWorkspace}`);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (r) => log("error", "unhandledRejection", { err: String(r?.stack || r).slice(0, 500) }));
  process.on("uncaughtException", (e) => log("error", "uncaughtException", { err: String(e.stack || e).slice(0, 500) }));
}

async function shutdown() {
  log("info", "gateway_shutdown");
  try { await telegram.stop(); await instagram.stop(); } catch {}
  try { unlinkSync(LOCK); } catch {}
  process.exit(0);
}

start().catch((e) => {
  console.error(`gateway falhou: ${e.message}`);
  log("error", "startup_failed", { err: e.stack });
  try { unlinkSync(LOCK); } catch {}
  process.exit(1);
});
