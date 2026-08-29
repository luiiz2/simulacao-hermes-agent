import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramAdapter } from "../src/adapters/telegram.mjs";
import { InstagramAdapter } from "../src/adapters/instagram.mjs";

const noop = () => {};

function fakeAdapter() {
  const t = new TelegramAdapter({ token: "1:a", allowedUserIds: ["111"], log: noop });
  const sent = [];
  let failNext = false;
  t._call = async (method, body) => {
    if (method === "getUpdates") return [];
    if (failNext && method === "sendMessage") throw new Error("boom");
    if (method === "sendMessage") sent.push(body.text);
    return { message_id: sent.length, text: body?.text };
  };
  return { t, sent, setFail: (v) => (failNext = v) };
}

test("autorização: usuário permitido passa, estranho bloqueia", () => {
  const { t } = fakeAdapter();
  assert.equal(t.isAllowed("111"), true);
  assert.equal(t.isAllowed("999"), false);
});

test("mensagem dividida quando excede limite", async () => {
  const { t, sent } = fakeAdapter();
  await t.sendMessage("1", "x".repeat(9000));
  assert.equal(sent.length, 3);
});

test("instagram desabilitado não derruba telegram (isolamento)", async () => {
  process.env.INSTAGRAM_ENABLED = "false";
  const ig = new InstagramAdapter({ log: noop });
  const r = await ig.start(); // não deve lançar
  assert.equal(r.disabled, true);
  await ig.sendMessage("1", "oi").catch((e) => assert.ok(/desabilitado/i.test(e.message)));
});

test("dedup de webhook instagram", () => {
  process.env.INSTAGRAM_ENABLED = "false";
  const ig = new InstagramAdapter({ log: noop });
  assert.equal(ig._dup("m1"), false);
  assert.equal(ig._dup("m1"), true);
  assert.equal(ig._dup("m2"), false);
});

test("instagram habilitado exige segredo do app para validar webhook", async () => {
  const names = ["INSTAGRAM_ENABLED", "META_ACCESS_TOKEN", "INSTAGRAM_ACCOUNT_ID", "META_VERIFY_TOKEN", "META_APP_SECRET"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.INSTAGRAM_ENABLED = "true";
  process.env.META_ACCESS_TOKEN = "token";
  process.env.INSTAGRAM_ACCOUNT_ID = "account";
  process.env.META_VERIFY_TOKEN = "verify";
  delete process.env.META_APP_SECRET;

  try {
    const ig = new InstagramAdapter({ log: noop, allowedUserIds: ["user"] });
    await assert.rejects(() => ig.start(), /META_APP_SECRET/);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("downloadFile bloqueia arquivo acima do limite configurado", async () => {
  const t = new TelegramAdapter({ token: "1:a", allowedUserIds: ["111"], log: noop, maxAttachmentBytes: 4 });
  t._call = async () => ({ file_path: "large.txt" });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("12345", {
    status: 200,
    headers: { "content-length": "5" },
  });
  try {
    await assert.rejects(() => t.downloadFile("file"), /excede o limite/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("menu registration recebe lista do registry (smoke)", async () => {
  const { t } = fakeAdapter();
  let registered = null;
  t._call = async (method, body) => {
    if (method === "setMyCommands") registered = body.commands;
    if (method === "getUpdates") return [];
    return [];
  };
  const { menuForBot } = await import("../src/commandRegistry.mjs");
  await t.registerMenu(menuForBot(60));
  assert.ok(registered.length >= 20);
});

test("sendMessage repassa reply_markup para teclado inline", async () => {
  const { t } = fakeAdapter();
  let lastBody = null;
  t._call = async (method, body) => {
    lastBody = body;
    return { message_id: 10, text: body?.text };
  };
  const markup = { inline_keyboard: [[{ text: "Botão", callback_data: "cmd:test" }]] };
  await t.sendMessage("123", "Menu", { reply_markup: markup });
  assert.deepEqual(lastBody.reply_markup, markup);
});

test("normalizeMessage preserva photoPath e caption", () => {
  const { t } = fakeAdapter();
  const raw = {
    chat: { id: 123 },
    from: { id: 456, first_name: "Dev" },
    caption: "Veja este erro",
    photoPath: "C:/tmp/screenshot.png",
    message_id: 99,
  };
  const msg = t.normalizeMessage(raw);
  assert.equal(msg.text, "Veja este erro");
  assert.equal(msg.photoPath, "C:/tmp/screenshot.png");
  assert.equal(msg.userId, "456");
});

test("normalizeMessage preserva filePath e fileName para documentos", () => {
  const { t } = fakeAdapter();
  const raw = {
    chat: { id: 123 },
    from: { id: 456, first_name: "Dev" },
    caption: "Analise este script",
    filePath: "C:/tmp/script.py",
    fileName: "script.py",
    message_id: 100,
  };
  const msg = t.normalizeMessage(raw);
  assert.equal(msg.text, "Analise este script");
  assert.equal(msg.filePath, "C:/tmp/script.py");
  assert.equal(msg.fileName, "script.py");
});

test("normalizeMessage preserva MIME e marca downloads temporários", () => {
  const { t } = fakeAdapter();
  const msg = t.normalizeMessage({
    chat: { id: 123 },
    from: { id: 456, first_name: "Dev" },
    caption: "Analise",
    filePath: "C:/Users/Dev/AppData/Local/Temp/script.py",
    fileName: "script.py",
    fileMimeType: "text/x-python",
    cleanupPaths: ["C:/Users/Dev/AppData/Local/Temp/script.py"],
    message_id: 101,
  });
  assert.equal(msg.fileMimeType, "text/x-python");
  assert.deepEqual(msg.cleanupPaths, ["C:/Users/Dev/AppData/Local/Temp/script.py"]);
});

test("processamento de update persiste o offset depois do handler", async () => {
  const { t } = fakeAdapter();
  let savedOffset = null;
  let received = null;
  t.onOffset = (offset) => { savedOffset = offset; };
  t.onMessage = async (message) => { received = message; };

  await t._processUpdate({
    update_id: 41,
    message: {
      chat: { id: 123 },
      from: { id: 456, first_name: "Dev" },
      text: "olá",
      message_id: 102,
    },
  });

  assert.equal(t.offset, 42);
  assert.equal(savedOffset, 42);
  assert.equal(received.text, "olá");
});


test("splitMessage quebra texto longo preferencialmente em quebras de linha", async () => {
  const { splitMessage } = await import("../src/adapters/telegram.mjs");
  const p1 = "A".repeat(3500);
  const p2 = "B".repeat(1000);
  const full = `${p1}\n${p2}`;
  const parts = splitMessage(full, 4000);
  assert.equal(parts.length, 2);
  assert.equal(parts[0], p1);
  assert.equal(parts[1], p2);
});

test("splitMessage fecha e reabre blocos de código markdown quando particiona código longo", async () => {
  const { splitMessage } = await import("../src/adapters/telegram.mjs");
  const codeLines = Array.from({ length: 100 }, (_, i) => `console.log('linha ${i} ${"x".repeat(40)}');`).join("\n");
  const markdown = "```javascript\n" + codeLines + "\n```";
  const parts = splitMessage(markdown, 2000);
  assert.ok(parts.length >= 2);
  // Primeira parte deve terminar com fechamento de código
  assert.ok(parts[0].endsWith("```"));
  // Segunda parte deve reabrir com o identificador da linguagem
  assert.ok(parts[1].startsWith("```javascript"));
});
