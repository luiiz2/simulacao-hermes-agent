import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputerActions, LEVEL, classify } from "../src/computer.mjs";
import { modelFor, parseModelId, MODELS } from "../src/opencode.mjs";

// ---- confirmações ----
const noopLog = () => {};
const ca = () => new ComputerActions(noopLog);

test("shutdown é LEVEL.SENSITIVE e exige token", async () => {
  const c = ca();
  const r = await c.run("424242", "shutdown");
  assert.ok(r.confirm, "deveria retornar token de confirmação");
  assert.match(r.confirm, /^\d{6}$/);
});

test("token confirmado executa uma única vez", async () => {
  const c = ca();
  // usa 'open' via caminho sensível? open é SAFE; testamos com shutdown sem executar de verdade:
  // interceptamos trocando fn por no-op.
  const r = await c.run("424242", "shutdown");
  const entry = [...c.pending.values()][0];
  entry.fn = async () => "simulado";
  const ok = await c.confirm("424242", r.confirm);
  assert.equal(ok.result, "simulado");
  const again = await c.confirm("424242", r.confirm);
  assert.ok(again.error, "segundo uso deve falhar (single-use)");
});

test("token não serve para outro usuário", async () => {
  const c = ca();
  const r = await c.run("424242", "shutdown");
  const out = await c.confirm("999", r.confirm);
  assert.ok(out.error.includes("usuário"));
});

test("tentativa de outro usuário não consome o token", async () => {
  const c = ca();
  const r = await c.run("424242", "shutdown");
  const entry = [...c.pending.values()][0];
  entry.fn = async () => "simulado";
  await c.confirm("999", r.confirm);
  const ok = await c.confirm("424242", r.confirm);
  assert.equal(ok.result, "simulado");
});

test("token expira", async () => {
  const c = ca();
  const r = await c.run("424242", "shutdown");
  const entry = [...c.pending.values()][0];
  entry.exp = Date.now() - 1;
  const out = await c.confirm("424242", r.confirm);
  assert.ok(out.error.includes("expirado") || out.error.includes("inválido"));
});

test("classificação de níveis", () => {
  assert.equal(classify("sys"), LEVEL.SAFE);
  assert.equal(classify("shutdown"), LEVEL.SENSITIVE);
  assert.equal(classify("restart"), LEVEL.SENSITIVE);
});

// ---- modos/modelos ----
test("modo resolve modelo correto", () => {
  assert.equal(modelFor({ mode: "fast" }), MODELS.fast.id);
  assert.equal(modelFor({ mode: "deep" }), MODELS.deep.id);
  assert.equal(modelFor({ mode: "code" }), "opencode/hy3-free");
});

test("override manual vence o modo", () => {
  assert.equal(modelFor({ mode: "fast", modelOverride: "groq/x" }), "groq/x");
});

test("sem escolha explícita não resolve modelo automático", () => {
  assert.equal(modelFor({}), null);
});

test("parseModelId separa provider/model", () => {
  assert.deepEqual(parseModelId("omniroute/auto/fast"), { providerID: "omniroute", modelID: "auto/fast" });
  assert.deepEqual(parseModelId("solo"), { providerID: "omniroute", modelID: "solo" });
});
