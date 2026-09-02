// Agent Gateway — Telegram (+Instagram ready) → CommandRouter → OpenCode.
// OpenCode stays the agent; this is only the remote interface layer.

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { ROOT, CFG } from "./config.mjs";
import { log, setDebug } from "./logger.mjs";
import { sanitizeForChat } from "./sanitize.mjs";
import { SessionStore } from "./sessionStore.mjs";
import { OpencodeEngine, MODELS, modelFor } from "./opencode.mjs";
import { ComputerActions } from "./computer.mjs";
import { bindHandlers, resolve, menuForBot, helpText } from "./commandRegistry.mjs";
import { TelegramAdapter } from "./adapters/telegram.mjs";
import { InstagramAdapter } from "./adapters/instagram.mjs";
import { getAvailableProjects, findMatchingProjects, cleanProjectName } from "./projects.mjs";
import { isAllowedUser, isAdminUser, sessionBelongsToUser, sessionTag } from "./auth.mjs";
import { canDispatchCallback, canDispatchCommand, parseCallbackData, parseCommand } from "./router.mjs";
import { cleanupTemporaryFiles } from "./files.mjs";
import { RecentDeduplicator } from "./dedup.mjs";
import { missingSelection } from "./selection.mjs";
import { isPermissionAskedEvent, permissionMarkup, selectPendingPermission } from "./permissions.mjs";
import { SerialTaskQueue } from "./taskQueue.mjs";

process.chdir(process.env.GATEWAY_WORKDIR || ROOT);
mkdirSync(CFG.generalWorkspace, { recursive: true });

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
  workdir: CFG.generalWorkspace,
  log,
});

const telegram = new TelegramAdapter({
  token: CFG.telegramToken,
  allowedUserIds: CFG.allowedUsers,
  log,
  initialOffset: Number(store.data.telegramOffset || 0),
  maxAttachmentBytes: CFG.maxAttachmentBytes,
});
telegram.onOffset = (o) => {
  store.data.telegramOffset = o;
  store.save();
};
const instagram = new InstagramAdapter({ log, allowedUserIds: CFG.instagramAllowedUsers });
const adapters = [telegram, instagram];

let DEBUG = false;
const streams = new Map();      // opencode sessionID -> live stream state
const sessionChats = new Map(); // sessionID -> { channel, userId, chatId } (for permissions/ownership)
const pendingPerms = new Map(); // permID -> {sessionID, channel, chatId, ts}
const recentMessages = new RecentDeduplicator();
const modelMenus = new Map();
const aiQueue = new SerialTaskQueue();
const MODEL_MENU_TTL_MS = 10 * 60_000;
const MODEL_PAGE_SIZE = 12;

function modelMenuKey(target) {
  return `${target.channel}:${target.userId}`;
}

function providerFromModel(modelID) {
  const i = String(modelID || "").indexOf("/");
  return i === -1 ? String(modelID || "") : String(modelID).slice(0, i);
}

function modelLabel(modelID) {
  const value = String(modelID || "");
  const i = value.indexOf("/");
  return i === -1 ? value : value.slice(i + 1);
}

function rememberModelMenu(target, menu) {
  modelMenus.set(modelMenuKey(target), { ...menu, expiresAt: Date.now() + MODEL_MENU_TTL_MS });
}

function readModelMenu(target) {
  const key = modelMenuKey(target);
  const menu = modelMenus.get(key);
  if (!menu || menu.expiresAt < Date.now()) {
    modelMenus.delete(key);
    return null;
  }
  return menu;
}

function modelSelectionExtra(target, kind) {
  if (target.channel !== "telegram") return {};
  return {
    reply_markup: {
      inline_keyboard: [[{
        text: kind === "project" ? "📂 Escolher projeto" : "🧠 Escolher modelo",
        callback_data: kind === "project" ? "cmd:project" : "cmd:model",
      }]],
    },
  };
}

async function requireSelections(target, chat, reply) {
  const missing = missingSelection(chat, modelFor(chat));
  if (!missing) return false;
  if (missing === "project") {
    await reply(
      "📁 Escolha o projeto com /project (ou selecione **Sem projeto**) antes de enviar a tarefa. Nenhuma sessão será criada automaticamente.",
      modelSelectionExtra(target, "project"),
    );
  } else {
    await reply(
      "🧠 Escolha um modelo com /model antes de enviar a tarefa. Você poderá selecionar qualquer provedor/modelo disponível.",
      modelSelectionExtra(target, "model"),
    );
  }
  return true;
}

async function sendModelPicker(target, known, reply) {
  const models = [...new Set((known || []).filter(Boolean))];
  const providers = [...new Set(models.map(providerFromModel).filter(Boolean))];
  rememberModelMenu(target, { kind: "providers", providers });

  const current = target.chat?.modelOverride ||
    (target.chat?.modelSelected === true ? modelFor(target.chat) : null);
  const counts = new Map();
  for (const model of models) counts.set(providerFromModel(model), (counts.get(providerFromModel(model)) || 0) + 1);
  const lines = [
    `🧠 Modelo atual: \`${current || "não escolhido"}\``,
    "",
    "Escolha um atalho ou abra um provedor para ver os modelos disponíveis:",
    ...Object.entries(MODELS).map(([key, value]) => `• /${key} → \`${value.id}\``),
    "",
    "Provedores detectados:",
    ...(providers.length
      ? providers.map((provider) => `• ${provider} (${counts.get(provider)} modelo(s))`)
      : ["• Nenhum modelo foi listado pelo OpenCode."]),
    "",
    "Também é possível fixar diretamente: /model <provider/model>",
  ];

  const keyboard = [
    [
      { text: "🤖 AUTO", callback_data: "mode:auto" },
      { text: "⚡ FAST", callback_data: "mode:fast" },
    ],
    [
      { text: "💻 CODE", callback_data: "mode:code" },
      { text: "🧠 DEEP", callback_data: "mode:deep" },
    ],
  ];
  for (let i = 0; i < providers.length; i += 2) {
    keyboard.push(providers.slice(i, i + 2).map((provider, offset) => ({
      text: `📦 ${provider} (${counts.get(provider)})`.slice(0, 40),
      callback_data: `model_provider:${i + offset}`,
    })));
  }
  if (providers.length) keyboard.push([{ text: "🔄 Atualizar lista", callback_data: "model_providers" }]);
  const extra = target.channel === "telegram" ? { reply_markup: { inline_keyboard: keyboard } } : {};
  return reply(lines.join("\n"), extra);
}

async function sendModelPage(target, provider, models, page, reply) {
  const totalPages = Math.max(1, Math.ceil(models.length / MODEL_PAGE_SIZE));
  const currentPage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
  const items = models.slice(currentPage * MODEL_PAGE_SIZE, (currentPage + 1) * MODEL_PAGE_SIZE);
  rememberModelMenu(target, { kind: "models", provider, models, page: currentPage });

  const lines = [`📦 ${provider}: escolha o modelo (página ${currentPage + 1}/${totalPages})`, ""];
  items.forEach((model, i) => lines.push(`${currentPage * MODEL_PAGE_SIZE + i + 1}. \`${model}\``));
  if (!items.length) lines.push("Nenhum modelo encontrado neste provedor.");

  const keyboard = items.map((model, i) => [{
    text: `${i + 1}. ${modelLabel(model)}`.slice(0, 40),
    callback_data: `model:${i}`,
  }]);
  const navigation = [];
  if (currentPage > 0) navigation.push({ text: "⬅️ Anterior", callback_data: `model_page:${currentPage - 1}` });
  if (currentPage + 1 < totalPages) navigation.push({ text: "Próxima ➡️", callback_data: `model_page:${currentPage + 1}` });
  if (navigation.length) keyboard.push(navigation);
  keyboard.push([{ text: "↩️ Provedores", callback_data: "model_providers" }]);
  const extra = target.channel === "telegram" ? { reply_markup: { inline_keyboard: keyboard } } : {};
  return reply(lines.join("\n"), extra);
}

// ---------- small helpers ----------
function isAuthed(m) {
  return isAllowedUser(m.channel, m.userId, CFG);
}

function isDup(m) {
  return recentMessages.has(m);
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

function chatTaskKey(target) {
  return `${target.channel}:${target.userId}`;
}

function enqueueAi(m, chat, promptText) {
  return aiQueue.enqueue(chatTaskKey(m), () => aiFlow(m, chat, promptText));
}

// ---------- AI flow ----------
async function aiFlow(m, chat, promptText) {
  const t0 = Date.now();
  const fileRef = m.filePath || m.photoPath;
  const fileMimeType = m.fileMimeType || (m.photoPath ? "image/jpeg" : null);
  log("info", "ai_start", { channel: m.channel, user: m.userId, len: (promptText || "").length, file: !!fileRef });
  if (await requireSelections(m, chat, replyFn(m))) return null;
  await ensureServerMatches(chat);

  const session = await ensureSession(m, chat);
  store.updateChat(m.channel, m.userId, { lastPrompt: promptText });
  sessionChats.set(session.id, { channel: m.channel, userId: m.userId, chatId: m.chatId });

  const typing = setInterval(() => {
    if (m.channel === "telegram") telegram.sendTyping(m.chatId).catch(() => {});
    else if (m.channel === "instagram") instagram.sendTyping(m.chatId).catch(() => {});
  }, 3500);
  if (m.channel === "telegram") telegram.sendTyping(m.chatId).catch(() => {});
  else if (m.channel === "instagram") instagram.sendTyping(m.chatId).catch(() => {});

  let placeholder = null;
  if (m.channel === "telegram") {
    try { placeholder = await telegram.sendMessage(m.chatId, "💭 Pensando…"); } catch {}
    if (placeholder) {
      streams.set(session.id, {
        chatId: m.chatId,
        text: "",
        messageId: placeholder.message_id,
        startTime: Date.now(),
        lastEdit: Date.now(),
        hasFirstTextChunk: false,
        done: false,
      });
    }
  }

  const fallbacks = String(process.env.MODEL_FALLBACKS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const finalPrompt = fileRef
      ? `[Arquivo recebido e salvo em: ${fileRef}${m.fileName ? ` (nome original: ${m.fileName})` : ""}]\n${promptText || "Analise o arquivo enviado."}`
      : promptText;
    const { text: finalRaw } = await engine.promptWithFallback(session.id, finalPrompt, chat, {
      extras: fallbacks,
      photoPath: fileRef,
      filePath: fileRef,
      fileName: m.fileName,
      mimeType: fileMimeType,
      onFallback: async (failedModel, nextModel) => {
        log("warn", "model_fallback", { failed: failedModel, next: nextModel });
        await replyFn(m)(`⚠️ \`${failedModel}\` falhou — tentando \`${nextModel}\`…`).catch(() => {});
      },
    });
    const clean = sanitizeForChat(finalRaw).trim() ||
      "⚠️ Nenhum modelo conseguiu responder agora. Use /retry em alguns instantes.";
    log("info", "ai_done", { ms: Date.now() - t0, chars: clean.length });
    if (placeholder?.message_id && m.channel === "telegram") {
      const ok = await telegram.editMessage(m.chatId, placeholder.message_id, clean).then(() => true).catch(() => false);
      if (!ok) await replyFn(m)(clean).catch(() => {});
    } else {
      await replyFn(m)(clean).catch(() => {});
    }
    return clean;
  } catch (e) {
    log("error", "ai_failed", { err: e.message, ms: Date.now() - t0 });
    // Se a sessão expirou no servidor, reseta e tenta criar uma nova na próxima
    if (/not found|session/i.test(e.message)) {
      store.updateChat(m.channel, m.userId, { sessionId: null });
    }
    const msg = `❌ Erro no agente: ${sanitizeForChat(e.message).slice(0, 500)}`;
    if (placeholder?.message_id && m.channel === "telegram") {
      await telegram.editMessage(m.chatId, placeholder.message_id, msg).catch(() => {});
    } else {
      await replyFn(m)(msg).catch(() => {});
    }
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
// muda o workspace) cria outra. Se a sessão sumir do servidor, cria uma nova.
async function ensureSession(m, chat) {
  const isNoProject = chat.projectSelected === true && !chat.workspace;
  const projName = isNoProject || !chat.workspace ? "geral" : (chat.workspace.split(/[\\/]/).pop() || "proj");
  const tag = sessionTag(m.channel, m.userId);
  const titlePrefix = `${tag} [${projName}]`;

  if (chat.sessionId) {
    return { id: chat.sessionId };
  }

  const created = await engine.createSession(`${titlePrefix} ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`);
  store.updateChat(m.channel, m.userId, { sessionId: created.id });
  sessionChats.set(created.id, { channel: m.channel, userId: m.userId, chatId: m.chatId });
  const desc = isNoProject ? "Modo Geral (sem projeto)" : `Projeto: \`${projName}\``;
  await replyFn(m)(`🆕 Nova sessão criada (${desc} · \`${created.id.slice(0, 8)}…\`).`).catch(() => {});
  log("info", "session_created", { id: created.id });
  return created;
}

async function ensureServerMatches(chat) {
  const ws = chat.projectSelected === true && chat.workspace ? chat.workspace : CFG.generalWorkspace;
  const norm = (p) => String(p || "").replace(/[\\/]+$/, "").toLowerCase();
  if (norm(engine.workdir) !== norm(ws)) {
    await engine.restartServer(ws);
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

    const now = Date.now();

    // 1. Tool execution updates
    if (part.type === "tool") {
      const toolName = part.call?.name || part.tool || "ferramenta";
      const statusText = `⚙️ Executando \`${toolName}\`…`;
      if (st.messageId && (!st.lastStatus || now - st.lastEdit > 1000)) {
        st.lastStatus = statusText;
        st.lastEdit = now;
        telegram.editMessage(st.chatId, st.messageId, statusText).catch(() => {});
      }
      return;
    }

    // 2. Reasoning / Thinking updates
    if (part.type === "reasoning") {
      const elapsed = Math.max(1, Math.round((now - (st.startTime || now)) / 1000));
      const statusText = `💭 Pensando (${elapsed}s)…`;
      if (st.messageId && (!st.hasFirstTextChunk && now - st.lastEdit >= 1200)) {
        st.lastEdit = now;
        telegram.editMessage(st.chatId, st.messageId, statusText).catch(() => {});
      }
      return;
    }

    // 3. Assistant text chunks
    const isAssistant = part.type === "text" && part.time && typeof part.time === "object";
    if (!isAssistant) return;
    if (typeof part.text === "string") st.text = part.text;
    if (part.time.end) st.done = true;

    // Primeiro chunk de texto recebido: atualiza na hora!
    const isFirstChunk = !st.hasFirstTextChunk && st.text.trim().length > 0;
    if (st.messageId && st.text && (st.done || isFirstChunk || now - st.lastEdit >= 1000)) {
      st.hasFirstTextChunk = true;
      st.lastEdit = now;
      telegram.editMessage(st.chatId, st.messageId, sanitizeForChat(st.text)).catch(() => {});
      if (st.done) streams.delete(sid);
    }
  } else if (isPermissionAskedEvent(type)) {
    const id = props.permissionID ?? props.id ?? props.requestID;
    const sid = props.sessionID;
    const target = sid ? sessionChats.get(sid) : null;
    if (!id || !target) {
      log("warn", "permission_unroutable", {
        type,
        hasPermissionId: Boolean(id),
        hasSessionId: Boolean(sid),
      });
      return;
    }
    const { channel, chatId } = typeof target === "object" ? target : { channel: "telegram", chatId: target };
    pendingPerms.set(String(id), { sessionID: sid, channel, chatId, ts: Date.now() });
    const action = sanitizeForChat(props.title || props.action || props.permission || type);
    const msg = `⚠️ Confirmação necessária\nAção: ${action}\n\n/approve ${id}\nou /deny ${id}`;
    const extra = channel === "telegram" ? { reply_markup: permissionMarkup(String(id)) } : {};
    log("info", "permission_requested", { channel, action });
    if (channel === "telegram") telegram.sendMessage(chatId, msg, extra).catch(() => {});
    else if (channel === "instagram") instagram.sendMessage(chatId, msg).catch(() => {});
  }
});

// ---------- command handlers ----------
function setMode(mode) {
  return async (ctx) => {
    store.updateChat(ctx.channel, ctx.userId, { mode, modelOverride: null, modelSelected: true });
    await ctx.reply(`⚙️ Modo ${MODELS[mode].label}`);
  };
}

const HANDLERS = {
  new: async (ctx) => {
    const fresh = store.resetSession(ctx.channel, ctx.userId, true);
    const desc = fresh.workspace ? `Projeto mantido: \`${fresh.workspace}\`` : "Modo: Sem Projeto (Geral)";
    await ctx.reply(`🆕 Nova conversa iniciada.\n${desc}`);
  },
  sessions: async (ctx) => {
    const all = (await engine.listSessions()) ?? [];
    const mine = all.filter((s) => sessionBelongsToUser(s, ctx.channel, ctx.userId, sessionChats));
    if (!mine.length) return ctx.reply("Nenhuma conversa anterior encontrada.");

    const recent = mine.slice(-8).reverse();
    const lines = ["📂 **Suas conversas anteriores:**", ""];
    const keyboard = [];

    for (const s of recent) {
      const isCurrent = s.id === ctx.chat.sessionId;
      const cleanTitle = sanitizeForChat((s.title || "").replace(/^\[[^\]]+\]\s*/, "") || s.id);
      const projTag = s.directory ? `[${cleanProjectName(s.directory)}] ` : "";
      lines.push(`• \`${s.id.slice(0, 8)}…\` — ${projTag}${cleanTitle}${isCurrent ? " ← (ativa)" : ""}`);
      if (!isCurrent) {
        keyboard.push([{
          text: `▶️ ${projTag}${cleanTitle}`.slice(0, 36),
          callback_data: `session:${s.id}`,
        }]);
      }
    }

    lines.push("", "Toque em um botão para retomar ou use `/resume <id>`.");
    const extra = ctx.channel === "telegram" && keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {};
    await ctx.reply(lines.join("\n"), extra);
  },
  resume: async (ctx) => {
    const id = ctx.args.trim().replace(/`/g, "");
    if (!id) return ctx.reply("Uso: /resume <id>");
    const s = await engine.getSession(id).catch(() => null);
    if (!s || !sessionBelongsToUser(s, ctx.channel, ctx.userId, sessionChats)) {
      return ctx.reply("Sessão não encontrada ou não pertence a você.");
    }
    if (s.directory && existsSync(s.directory) && s.directory !== ctx.chat.workspace) {
      await engine.restartServer(s.directory);
      ctx.chat.workspace = s.directory;
      store.touchProject(s.directory);
    }
    sessionChats.set(s.id, { channel: ctx.channel, userId: ctx.userId, chatId: ctx.chatId });
    store.updateChat(ctx.channel, ctx.userId, {
      sessionId: s.id,
      workspace: ctx.chat.workspace || null,
      projectSelected: true,
    });
    const wsInfo = ctx.chat.workspace ? `\n📁 Workspace: \`${ctx.chat.workspace}\`` : "\n💬 Sem projeto";
    await ctx.reply(`▶️ Retomada: ${sanitizeForChat(s.title || s.id)}${wsInfo}`);
  },
  title: async (ctx) => {
    if (!ctx.args.trim()) return ctx.reply(`Título atual: ${ctx.chat.title || "(sem)"}`);
    const name = ctx.args.trim().slice(0, 60);
    if (ctx.chat.sessionId) await engine.updateSession(ctx.chat.sessionId, { title: `${sessionTag(ctx.channel, ctx.userId)} ${name}` }).catch(() => {});
    store.updateChat(ctx.channel, ctx.userId, { title: name });
    await ctx.reply(`🏷️ Título: ${name}`);
  },
  retry: async (ctx) => {
    if (!ctx.chat.lastPrompt) return ctx.reply("Nada para reenviar.");
    await enqueueAi(ctx.msg, ctx.chat, ctx.chat.lastPrompt);
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
    if (await requireSelections(ctx.msg, ctx.chat, ctx.reply)) return;
    const session = await engine.createSession(`${sessionTag(ctx.channel, ctx.userId)} [bg] ${ctx.args.trim().slice(0, 50)}`);
    sessionChats.set(session.id, { channel: ctx.channel, userId: ctx.userId, chatId: ctx.chatId });
    await ctx.reply(`🔄 Background iniciado (\`${session.id}\`). Aviso quando terminar.`);
    aiFlowBackground(ctx, session, ctx.args.trim());
  },
  stop: async (ctx) => {
    if (!ctx.chat.sessionId) return ctx.reply("Nada em execução.");
    const ok = await engine.abortSession(ctx.chat.sessionId);
    await ctx.reply(ok ? "🛑 Tarefa cancelada." : "Não havia tarefa rodando.");
  },

  model: async (ctx) => {
    const current = ctx.chat.modelOverride ||
      (ctx.chat.modelSelected === true ? modelFor(ctx.chat) : null);
    if (!ctx.args.trim()) {
      const known = await engine.providers();
      return sendModelPicker(ctx, known, ctx.reply);
    }
    let wanted = ctx.args.trim();
    const known = await engine.providers();
    if (known.length && !known.includes(wanted)) {
      const normalized = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
      const matches = known.filter((model) => normalized(model).includes(normalized(wanted)));
      if (matches.length === 1) wanted = matches[0];
      else {
        const examples = (matches.length ? matches : known).slice(0, 12);
        return ctx.reply(`Modelo não encontrado ou ambíguo: \`${ctx.args.trim()}\`. Escolha em /model ou use um ID completo:\n${examples.map((k) => `\`${k}\``).join("\n")}`);
      }
    }
    store.updateChat(ctx.channel, ctx.userId, { modelOverride: wanted, modelSelected: true });
    await ctx.reply(`🧠 Modelo fixado: \`${wanted}\`\nUse /model sem argumento para trocar.`);
  },
  auto: setMode("auto"),
  fast: setMode("fast"),
  code: setMode("code"),
  deep: setMode("deep"),

  project: async (ctx) => {
    const rawArg = ctx.args.trim().replace(/^"|"$/g, "");
    const sessions = (await engine.listSessions().catch(() => [])) ?? [];
    const sessionDirs = sessions.map((s) => s.directory).filter(Boolean);
    const available = getAvailableProjects(store.data.projects, CFG.defaultWorkspace, sessionDirs);

    if (!rawArg) {
      const currentDesc = !ctx.chat.projectSelected
        ? "📁 Nenhum projeto escolhido ainda."
        : ctx.chat.workspace
        ? `📁 Projeto ativo: \`${ctx.chat.workspace}\``
        : "💬 Modo ativo: **Sem Projeto (Geral)**";

      const lines = [
        currentDesc,
        "",
        "📂 **Projetos disponíveis:**",
      ];

      const keyboard = [];
      available.slice(0, 6).forEach((p, i) => {
        const isCurrent = ctx.chat.projectSelected && p === ctx.chat.workspace;
        const name = cleanProjectName(p);
        lines.push(`${i + 1}. ${name}${isCurrent ? " ← ativo" : ""} (\`${p}\`)`);
        const projectIndex = store.data.projects.indexOf(p);
        keyboard.push([{
          text: `${isCurrent ? "● " : "📁 "}${name}`,
          callback_data: projectIndex >= 0
            ? `proj:${projectIndex}`
            : `proj_path:${Buffer.from(p).toString("base64url")}`,
        }]);
      });

      keyboard.push([
        { text: `${ctx.chat.projectSelected && !ctx.chat.workspace ? "● " : "💬 "}Sem projeto (Geral)`, callback_data: "proj:none" },
        { text: "📂 Conversas", callback_data: "cmd:sessions" },
      ]);

      lines.push(
        "",
        "💡 **Dicas:**",
        "• Toque no botão para alternar de projeto",
        "• Buscar projeto por nome: `/project <nome>` (ex: `/project hermes`)",
        "• Abrir pasta nova: `/project C:\\caminho\\da\\pasta`",
        "• Modo sem projeto: `/project none`"
      );

      const extra = ctx.channel === "telegram" ? { reply_markup: { inline_keyboard: keyboard } } : {};
      return ctx.reply(lines.join("\n"), extra);
    }

    // 1. Sem projeto
    if (/^(none|sem|geral|off|scratch)$/i.test(rawArg)) {
      ctx.chat.workspace = null;
      store.updateChat(ctx.channel, ctx.userId, { workspace: null, projectSelected: true });
      const fresh = store.resetSession(ctx.channel, ctx.userId, false);
      fresh.workspace = null;
      fresh.projectSelected = true;
      store.save();
      return ctx.reply("💬 Modo **Sem Projeto (Geral)** ativado.\nNovas sessões criadas não estarão presas a nenhuma pasta.");
    }

    // 2. Caminho exato que existe no disco
    if (existsSync(rawArg)) {
      const dir = rawArg;
      await engine.restartServer(dir);
      store.touchProject(dir);
      store.resetSession(ctx.channel, ctx.userId, false);
      const fresh = store.getChat(ctx.channel, ctx.userId, dir);
      fresh.workspace = dir;
      fresh.projectSelected = true;
      store.save();
      return ctx.reply(`📁 Projeto alterado para: \`${dir}\`\n🆕 Nova conversa criada exclusivamente neste projeto.`);
    }

    // 3. Busca por nome / termo
    const matches = findMatchingProjects(rawArg, available);

    if (matches.length === 1) {
      const dir = matches[0];
      await engine.restartServer(dir);
      store.touchProject(dir);
      store.resetSession(ctx.channel, ctx.userId, false);
      const fresh = store.getChat(ctx.channel, ctx.userId, dir);
      fresh.workspace = dir;
      fresh.projectSelected = true;
      store.save();
      return ctx.reply(`✅ Projeto encontrado e ativado: \`${dir}\`\n🆕 Nova conversa criada exclusivamente neste projeto.`);
    }

    if (matches.length > 1) {
      const lines = [`🔍 Vários projetos encontrados para "${rawArg}":`, ""];
      const keyboard = matches.slice(0, 8).map((p, i) => {
        const name = p.split(/[\\/]/).pop() || p;
        lines.push(`• **${name}** (\`${p}\`)`);
        const idx = store.data.projects.indexOf(p);
        const ref = idx >= 0 ? `proj:${idx}` : `proj_path:${Buffer.from(p).toString("base64url")}`;
        return [{ text: `📁 ${name}`, callback_data: ref }];
      });
      lines.push("", "Toque no projeto desejado para ativá-lo:");
      const extra = ctx.channel === "telegram" ? { reply_markup: { inline_keyboard: keyboard } } : {};
      return ctx.reply(lines.join("\n"), extra);
    }

    return ctx.reply(`❌ Nenhum projeto encontrado com o termo "${rawArg}".\nUse \`/project\` para ver a lista de projetos ou informe o caminho completo.`);
  },
  diff: async (ctx) => {
    if (!ctx.chat.sessionId) return ctx.reply("Sem conversa ativa.");
    const diffs = await engine.diffSession(ctx.chat.sessionId);
    if (!diffs || !Array.isArray(diffs) || !diffs.length) {
      return ctx.reply("Nenhuma alteração de arquivo registrada nesta sessão.");
    }
    const lines = ["📝 **Alterações na sessão:**\n"];
    for (const d of diffs) {
      const file = d.file || d.path || "arquivo";
      const adds = d.additions ?? d.added ?? 0;
      const dels = d.deletions ?? d.removed ?? 0;
      lines.push(`• \`${file}\` (+${adds} / -${dels})`);
    }
    await ctx.reply(lines.join("\n"));
  },
  status: async (ctx) => {
    const healthy = await engine.healthy();
    const busy = aiQueue.has(chatTaskKey(ctx)) || [...streams.values()].some((s) => !s.done);
    const project = !ctx.chat.projectSelected
      ? "não escolhido"
      : (ctx.chat.workspace || "sem projeto");
    const model = ctx.chat.modelOverride ||
      (ctx.chat.modelSelected === true ? modelFor(ctx.chat) : null);
    const lines = [
      `${healthy ? "🟢" : "🔴"} Agent ${healthy ? "online" : "offline"}`,
      `Projeto: \`${project}\``,
      `Mode: ${(ctx.chat.mode || "—").toUpperCase()}`,
      `Modelo: \`${model || "não escolhido"}\``,
      `Session: \`${ctx.chat.sessionId || "—"}\``,
      `Task: ${busy ? "executando" : "idle"}`,
      `Gateway: online`,
    ];
    if (DEBUG) lines.push(`Uptime: ${Math.round(process.uptime())}s · Chats: ${Object.keys(store.data.chats).length}`);
    const extra = ctx.channel === "telegram" ? {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🆕 Novo Chat", callback_data: "cmd:new" },
            { text: "⚙️ Modos", callback_data: "cmd:model" },
          ],
          [
            { text: "📁 Projetos", callback_data: "cmd:project" },
            { text: "🔄 Atualizar", callback_data: "cmd:status" },
          ],
        ],
      },
    } : {};
    await ctx.reply(lines.join("\n"), extra);
  },
  whoami: async (ctx) => {
    const admin = isAdminUser(ctx.userId, CFG);
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
      if (ctx.channel === "telegram") {
        try {
          await telegram.sendPhoto(ctx.chatId, r.result.screenshotPath, "📸 Captura de tela");
          return;
        } catch (e) { return ctx.reply(`Falha ao enviar print: ${e.message.slice(0, 150)}`); }
        finally { await cleanupTemporaryFiles([r.result.screenshotPath]); }
      }
      await cleanupTemporaryFiles([r.result.screenshotPath]);
      return ctx.reply("📸 Captura de tela disponível apenas pelo Telegram.");
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
    const selection = selectPendingPermission(pendingPerms, ctx.args, {
      channel: ctx.channel,
      chatId: ctx.chatId,
    });
    const command = response === "allow" ? "approve" : "deny";
    if (selection.status === "ambiguous") {
      return ctx.reply(
        `Há várias permissões pendentes neste chat. Use /${command} <ID>:\n${selection.ids.map((id) => `• ${id}`).join("\n")}`
      );
    }
    if (selection.status === "expired") {
      pendingPerms.delete(selection.id);
      return ctx.reply("Permissão expirada (>30 min). Peça a ação novamente.");
    }
    if (selection.status !== "found") {
      return ctx.reply(`Uso: /${command} <ID>. Nenhuma permissão pendente encontrada neste chat.`);
    }
    const { id, entry: p } = selection;
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
    await ctx.reply(`✅ Background concluído (\`${session.id}\`):\n\n${text.slice(0, 3500)}`);
  } catch (e) {
    await ctx.reply(`❌ Background falhou: ${sanitizeForChat(e.message).slice(0, 300)}`).catch(() => {});
  }
}

bindHandlers(HANDLERS);

// ---------- router ----------
async function handleMessage(m) {
  try {
    return await handleMessageInner(m);
  } finally {
    await cleanupTemporaryFiles(m.cleanupPaths);
  }
}

async function handleMessageInner(m) {
  const t0 = Date.now();
  if (!isAuthed(m)) {
    log("warn", "unauthorized_ignored", { channel: m.channel, user: m.userId });
    if (m.channel === "telegram")
      telegram.sendMessage(m.chatId, "🔒 Não autorizado.").catch(() => {});
    return;
  }
  if (isDup(m)) { log("info", "dup_dropped", { user: m.userId }); return; }

  const text = (m.text || "").trim();
  const chat = store.getChat(m.channel, m.userId, null);
  if (chat.workspace === undefined) { chat.workspace = null; store.save(); }
  if (chat.projectSelected && chat.workspace && !store.data.projects.includes(chat.workspace)) store.touchProject(chat.workspace);

  const command = parseCommand(text);
  if (command) {
    const hit = resolve(command.name);
    if (!hit) { await replyFn(m)(`Comando desconhecido: /${command.name}. Use /help.`); return; }

    if (!canDispatchCommand(hit.def, m.userId, CFG)) {
      log("warn", "admin_command_denied", { cmd: hit.def.name, user: m.userId });
      await replyFn(m)("⛔ Permissão negada: comando exclusivo para administradores.");
      return;
    }

    if (hit.handler) {
      log("info", "command", { cmd: hit.def.name, user: m.userId });
      await hit.handler(makeCtx(m, chat, command.args));
      log("info", "command_done", { cmd: hit.def.name, ms: Date.now() - t0 });
      return;
    }
  }

  await enqueueAi(m, chat, text);
}

// ---------- callbacks ----------
telegram.onCallback = async (c) => {
  if (!canDispatchCallback({ perm: "user" }, c.userId, CFG, c.channel)) {
    log("warn", "unauthorized_callback_ignored", { user: c.userId });
    telegram.answerCallback(c.callbackId, "Não autorizado").catch(() => {});
    return;
  }
  telegram.answerCallback(c.callbackId).catch(() => {});
  const parsed = parseCallbackData(c.data);
  if (!parsed) return;
  const [a, b] = parsed.args;
  const kind = parsed.kind;
  const chat = store.getChat(c.channel, c.userId, null);
  const makeFakeCtx = (args = "") => makeCtx({ channel: c.channel, userId: c.userId, chatId: c.chatId, text: "" }, chat, args);
  const callbackReply = (text, extra = {}) => telegram.sendMessage(c.chatId, text, extra);

  if (kind === "model_providers") {
    await sendModelPicker({ ...c, chat }, await engine.providers(), callbackReply);
  } else if (kind === "model_provider") {
    const menu = readModelMenu(c);
    const index = Number(a);
    const provider = menu?.kind === "providers" && Number.isInteger(index) ? menu.providers[index] : null;
    if (!provider) {
      await callbackReply("A lista de modelos expirou. Use /model novamente.");
      return;
    }
    const models = (await engine.providers()).filter((model) => providerFromModel(model) === provider);
    await sendModelPage({ ...c, chat }, provider, models, 0, callbackReply);
  } else if (kind === "model_page") {
    const menu = readModelMenu(c);
    if (menu?.kind !== "models") {
      await callbackReply("A lista de modelos expirou. Use /model novamente.");
      return;
    }
    await sendModelPage({ ...c, chat }, menu.provider, menu.models, Number(a), callbackReply);
  } else if (kind === "model") {
    const menu = readModelMenu(c);
    const index = Number(a);
    const absoluteIndex = (menu?.page || 0) * MODEL_PAGE_SIZE + index;
    const wanted = menu?.kind === "models" && Number.isInteger(index) ? menu.models[absoluteIndex] : null;
    if (!wanted) {
      await callbackReply("A lista de modelos expirou. Use /model novamente.");
      return;
    }
    store.updateChat(c.channel, c.userId, { modelOverride: wanted, modelSelected: true });
    await callbackReply(`🧠 Modelo fixado: \`${wanted}\`\nUse /model para trocar.`);
  } else if (kind === "mode") {
    if (!MODELS[a]) return;
    store.updateChat(c.channel, c.userId, { mode: a, modelOverride: null, modelSelected: true });
    telegram.sendMessage(c.chatId, `⚙️ Modo alterado para ${MODELS[a]?.label ?? a}`).catch(() => {});
  } else if (kind === "proj") {
    if (a === "none") {
      chat.workspace = null;
      store.updateChat(c.channel, c.userId, { workspace: null, projectSelected: true });
      const fresh = store.resetSession(c.channel, c.userId, false);
      fresh.workspace = null;
      fresh.projectSelected = true;
      store.save();
      telegram.sendMessage(c.chatId, "💬 Modo **Sem Projeto (Geral)** ativado. Nova conversa criada.").catch(() => {});
      return;
    }
    const index = Number(a);
    const dir = Number.isInteger(index) && index >= 0 ? store.data.projects[index] : null;
    if (!dir) return;
    await engine.restartServer(dir);
    store.resetSession(c.channel, c.userId, false);
    const fresh = store.getChat(c.channel, c.userId, dir);
    fresh.workspace = dir;
    fresh.projectSelected = true;
    store.save();
    telegram.sendMessage(c.chatId, `📁 Projeto alterado para: \`${dir}\`\n🆕 Nova sessão criada nele.`).catch(() => {});
  } else if (kind === "proj_path") {
    try {
      const dir = Buffer.from(a, "base64url").toString("utf8");
      if (!existsSync(dir)) return telegram.sendMessage(c.chatId, "Pasta não encontrada.").catch(() => {});
      await engine.restartServer(dir);
      store.touchProject(dir);
      store.resetSession(c.channel, c.userId, false);
      const fresh = store.getChat(c.channel, c.userId, dir);
      fresh.workspace = dir;
      fresh.projectSelected = true;
      store.save();
      telegram.sendMessage(c.chatId, `📁 Projeto alterado para: \`${dir}\`\n🆕 Nova sessão criada nele.`).catch(() => {});
    } catch {}
  } else if (kind === "session") {
    const s = await engine.getSession(a).catch(() => null);
    if (!s || !sessionBelongsToUser(s, c.channel, c.userId, sessionChats)) {
      return telegram.sendMessage(c.chatId, "Sessão não encontrada ou não pertence a você.").catch(() => {});
    }
    if (s.directory && existsSync(s.directory) && s.directory !== chat.workspace) {
      await engine.restartServer(s.directory);
      chat.workspace = s.directory;
      store.touchProject(s.directory);
    }
    sessionChats.set(s.id, { channel: c.channel, userId: c.userId, chatId: c.chatId });
    store.updateChat(c.channel, c.userId, {
      sessionId: s.id,
      workspace: chat.workspace || null,
      projectSelected: true,
    });
    const wsInfo = chat.workspace ? `\n📁 Workspace: \`${chat.workspace}\`` : "\n💬 Sem projeto";
    telegram.sendMessage(c.chatId, `▶️ Conversa retomada: ${sanitizeForChat(s.title || s.id)}${wsInfo}`).catch(() => {});
  } else if (kind === "cmd") {
    const hit = resolve(a);
    if (hit?.handler && canDispatchCommand(hit.def, c.userId, CFG)) {
      await hit.handler(makeFakeCtx());
    }
  } else if (kind === "perm") {
    if (!isAdminUser(c.userId, CFG)) return;
    const response = b === "y" ? "allow" : b === "n" ? "deny" : null;
    if (!response) return telegram.sendMessage(c.chatId, "Resposta de permissão inválida.").catch(() => {});
    const selection = selectPendingPermission(pendingPerms, a, {
      channel: c.channel,
      chatId: c.chatId,
    });
    if (selection.status === "expired") {
      pendingPerms.delete(selection.id);
      telegram.sendMessage(c.chatId, "Permissão expirada (>30 min).").catch(() => {});
      return;
    }
    if (selection.status !== "found") {
      telegram.sendMessage(c.chatId, "Permissão expirada ou não encontrada.").catch(() => {});
      return;
    }
    const { id, entry: p } = selection;
    pendingPerms.delete(id);
    const ok = await engine.respondPermission(p.sessionID, id, response);
    telegram.sendMessage(c.chatId, ok ? (response === "allow" ? "✅ Aprovada." : "🚫 Negada.") : "Falha.").catch(() => {});
  }
};

telegram.onMessage = (m) => handleMessage(m).catch((e) => log("error", "tg_handle_error", { err: e.stack }));
instagram.onMessage = (m) => handleMessage(m).catch((e) => log("error", "ig_handle_error", { err: e.stack }));

// ---------- watchdog ----------
let watchdogTimer = null;
function startWatchdog(intervalMs = 30_000) {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(async () => {
    try {
      const isUp = await engine.healthy(3000);
      if (!isUp) {
        log("warn", "opencode_watchdog_unhealthy", { workdir: engine.workdir });
        await engine.ensureServer(engine.workdir);
      }
    } catch (e) {
      log("error", "opencode_watchdog_error", { err: e.message });
    }
  }, intervalMs);
  watchdogTimer.unref();
}

// ---------- lifecycle ----------
async function start() {
  log("info", "gateway_start", { pid: process.pid, workspace: CFG.generalWorkspace });
  await engine.ensureServer(CFG.generalWorkspace);
  startWatchdog(30_000);
  const tgInfo = await telegram.start();

  try {
    await instagram.start();
  } catch (e) {
    log("error", "instagram_start_failed_isolated", { err: e.message });
  }

  const refreshMenu = () => telegram.registerMenu(menuForBot(60)).catch((e) => log("warn", "menu_failed", { err: e.message }));
  await refreshMenu();
  setInterval(refreshMenu, 3_600_000).unref();

  console.log(`✅ Gateway online — @${tgInfo.username} | aguardando escolha de projeto e modelo`);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (r) => log("error", "unhandledRejection", { err: String(r?.stack || r).slice(0, 500) }));
  process.on("uncaughtException", (e) => log("error", "uncaughtException", { err: String(e.stack || e).slice(0, 500) }));
}

async function shutdown() {
  log("info", "gateway_shutdown");
  if (watchdogTimer) clearInterval(watchdogTimer);
  try { await telegram.stop(); await instagram.stop(); } catch {}
  try { await engine.stopServer(); } catch {}
  try { unlinkSync(LOCK); } catch {}
  process.exit(0);
}

start().catch((e) => {
  console.error(`gateway falhou: ${e.message}`);
  log("error", "startup_failed", { err: e.stack });
  try { unlinkSync(LOCK); } catch {}
  process.exit(1);
});
