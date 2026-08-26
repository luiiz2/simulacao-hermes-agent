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
