import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFallbackChain, extractText } from "../src/opencode.mjs";

test("cadeia de fallback: principal primeiro, extras sem duplicar", () => {
  const chain = buildFallbackChain("opencode/x-preview-f-free", [
    "opencode/x-preview-f-free",
    "omniroute/auto/best-coding",
    "",
    "opencode/x-preview-f-free",
  ]);
  assert.deepEqual(chain, ["opencode/x-preview-f-free", "omniroute/auto/best-coding"]);
});

test("cadeia com extras vazios mantém só o principal", () => {
  assert.deepEqual(buildFallbackChain("a/b", []), ["a/b"]);
});

test("extractText junta partes de texto e ignora outras", () => {
  const r = { parts: [{ type: "text", text: "olá" }, { type: "tool", text: "x" }, { type: "text", text: "mundo" }] };
  assert.equal(extractText(r), "olá\nmundo");
  assert.equal(extractText(null), "");
});
