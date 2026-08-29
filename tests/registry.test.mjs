import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFS, resolve, menuForBot, helpText, bindHandlers } from "../src/commandRegistry.mjs";

test("registry não tem nomes/aliases duplicados", () => {
  const seen = new Set();
  for (const d of DEFS) {
    for (const n of [d.name, ...d.aliases]) {
      assert.ok(!seen.has(n), `duplicado: ${n}`);
      seen.add(n);
    }
  }
});

test("resolve por alias (reset → new e compact → compress)", () => {
  const hit = resolve("/reset");
  assert.equal(hit.def.name, "new");
  const hitCompact = resolve("/compact");
  assert.equal(hitCompact.def.name, "compress");
  const hitDiff = resolve("/diffs");
  assert.equal(hitDiff.def.name, "diff");
});

test("menu do bot vem do registry", () => {
  const menu = menuForBot(60);
  assert.ok(menu.length >= 20 && menu.length <= 60);
  assert.ok(menu.every((c) => c.command && c.description));
  assert.ok(menu.some((c) => c.command === "status"));
  assert.ok(menu.some((c) => c.command === "diff"));
});

test("help agrupa por categoria e menciona comandos", () => {
  const h = helpText();
  assert.ok(h.includes("*MODELO*") || h.includes("MODELO"));
  assert.ok(h.includes("/model"));
});

test("handler ausente não quebra resolve", () => {
  bindHandlers({});
  const hit = resolve("/sys");
  assert.equal(hit.def.name, "sys");
  assert.equal(hit.handler, undefined);
});

test("comandos críticos possuem perm: admin e comuns perm: user", () => {
  const adminCmds = ["shutdown", "restart", "sys", "ps", "open", "url", "shot", "confirm", "approve", "deny", "debug"];
  for (const cmd of adminCmds) {
    const hit = resolve(cmd);
    assert.ok(hit, `comando ${cmd} não encontrado`);
    assert.equal(hit.def.perm, "admin", `${cmd} deve ter perm admin`);
  }

  const userCmds = ["new", "status", "help", "model", "auto", "fast", "code", "deep", "project", "diff", "compress"];
  for (const cmd of userCmds) {
    const hit = resolve(cmd);
    assert.ok(hit, `comando ${cmd} não encontrado`);
    assert.equal(hit.def.perm, "user", `${cmd} deve ter perm user`);
  }
});
