import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeForChat, stripTerminalNoise, redactSecrets } from "../src/sanitize.mjs";

test("remove sequência ANSI real", () => {
  assert.equal(stripTerminalNoise("\x1b[0mHello"), "Hello");
});

test("remove [0m literal colado", () => {
  assert.equal(sanitizeForChat("[0mHello"), "Hello");
});

test("remove ANSI colorido mantendo texto", () => {
  assert.equal(stripTerminalNoise("\x1b[32mSuccess\x1b[0m"), "Success");
});

test("remove banner '> build · auto/best-coding'", () => {
  const out = sanitizeForChat("> build · auto/best-coding\nOlá!");
  assert.equal(out, "Olá!");
  assert.ok(!out.includes("best-coding"));
});

test("banner sem > também é removido", () => {
  const out = sanitizeForChat("build · auto/best-coding\nteste");
  assert.equal(out, "teste");
});

test("preserva markdown legítimo e código", () => {
  const src = "**negrito** `code`\n```js\nconst a = [1, 2];\n```";
  assert.ok(sanitizeForChat(src).includes("const a = [1, 2];"));
});

test("remove caracteres de controle", () => {
  assert.equal(stripTerminalNoise("a\x07b\x08c"), "abc");
});

test("redact: chave sk-", () => {
  assert.ok(!redactSecrets("chave sk-proj-abc123def456").includes("sk-proj"));
  assert.ok(redactSecrets("chave sk-proj-abc123def456").includes("[REDACTED_SECRET]"));
});

test("redact: token de bot do telegram", () => {
  const out = redactSecrets("token 123456789:AAHfaketokenFaketokenFakeTokenFake12 fim");
  assert.ok(out.includes("[REDACTED_BOT_TOKEN]"));
  assert.ok(!out.includes("AAHfaketoken"));
});

test("redact: KEY=value com TOKEN/SECRET no nome", () => {
  assert.equal(redactSecrets("MY_SECRET=hunter2"), "MY_SECRET=[REDACTED]");
});

test("stripTerminalNoise normaliza quebras CRLF do Windows", () => {
  assert.equal(stripTerminalNoise("linha 1\r\nlinha 2\r\n"), "linha 1\nlinha 2");
});
