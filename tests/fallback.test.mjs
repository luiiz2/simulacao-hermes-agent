import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFallbackChain,
  buildOpenCodeSpawnEnv,
  extractText,
  OpencodeEngine,
  parseServerEndpoint,
  providerModelIds,
  resolveModelId,
} from "../src/opencode.mjs";

test("servidor headless no Windows isola a config global problemática sem mover dados", () => {
  const root = mkdtempSync(join(tmpdir(), "gateway-opencode-env-"));
  const configDir = join(root, ".config", "opencode");
  const localAppData = join(root, "AppData", "Local");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "opencode.json"), "{}");

  try {
    const env = buildOpenCodeSpawnEnv({
      USERPROFILE: root,
      LOCALAPPDATA: localAppData,
      OPENCODE_SERVER_USERNAME: "u",
      OPENCODE_SERVER_PASSWORD: "p",
    }, "win32");

    assert.equal(env.XDG_CONFIG_HOME, join(localAppData, "AgentGateway", "opencode-config"));
    assert.equal(env.OPENCODE_CONFIG, join(configDir, "opencode.json"));
    assert.equal(env.OPENCODE_CONFIG_DIR, configDir);
    assert.equal(env.XDG_DATA_HOME, undefined);
    assert.equal(env.OPENCODE_SERVER_USERNAME, "u");
    assert.equal(env.OPENCODE_SERVER_PASSWORD, "p");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("prompt inclui anexo file quando photoPath é fornecido", async () => {
  const engine = new OpencodeEngine({
    baseUrl: "http://127.0.0.1:4096",
    username: "u",
    password: "p",
    workdir: "C:/",
    log: () => {},
  });
  let promptBody = null;
  engine.client.session.prompt = async (opts) => {
    promptBody = opts.body;
    return { data: { parts: [{ type: "text", text: "Imagem analisada com sucesso" }] } };
  };
  const res = await engine.prompt("ses_1", "analise isso", { mode: "auto" }, { photoPath: "C:/tmp/foto.png" });
  assert.equal(promptBody.parts.length, 2);
  assert.equal(promptBody.parts[0].text, "analise isso");
  assert.equal(promptBody.parts[1].type, "file");
  assert.equal(promptBody.parts[1].mime, "image/png");
  assert.ok(promptBody.parts[1].url.includes("foto.png"));
});

test("prompt preserva MIME e nome de documento anexado", async () => {
  const engine = new OpencodeEngine({
    baseUrl: "http://127.0.0.1:4096",
    username: "u",
    password: "p",
    workdir: "C:/",
    log: () => {},
  });
  let promptBody = null;
  engine.client.session.prompt = async (opts) => {
    promptBody = opts.body;
    return { data: { parts: [{ type: "text", text: "ok" }] } };
  };

  await engine.prompt("ses_2", "analise", { mode: "auto" }, {
    filePath: "C:/tmp/script.py",
    fileName: "script.py",
    mimeType: "text/x-python",
  });

  assert.equal(promptBody.parts[1].mime, "text/x-python");
  assert.equal(promptBody.parts[1].filename, "script.py");
});

test("parseServerEndpoint extrai host e porta configuráveis", () => {
  assert.deepEqual(parseServerEndpoint("http://localhost:4097/"), {
    baseUrl: "http://localhost:4097",
    hostname: "localhost",
    port: "4097",
    protocol: "http:",
  });
});

test("respondPermission chama postSessionIdPermissionsPermissionId com parâmetros corretos", async () => {
  const engine = new OpencodeEngine({
    baseUrl: "http://127.0.0.1:4096",
    username: "u",
    password: "p",
    workdir: "C:/",
    log: () => {},
  });
  let called = null;
  engine.client.postSessionIdPermissionsPermissionId = async (opts) => {
    called = opts;
    return { data: { success: true } };
  };
  const ok = await engine.respondPermission("ses_123", "perm_456", "allow");
  assert.equal(ok, true);
  assert.deepEqual(called, {
    path: { id: "ses_123", permissionID: "perm_456" },
    body: { response: "allow" },
  });
});

test("diffSession retorna lista de diffs da sessão", async () => {
  const engine = new OpencodeEngine({
    baseUrl: "http://127.0.0.1:4096",
    username: "u",
    password: "p",
    workdir: "C:/",
    log: () => {},
  });
  engine.client.session.diff = async (opts) => {
    assert.equal(opts.path.id, "ses_999");
    return { data: [{ file: "src/index.js", additions: 5, deletions: 2 }] };
  };
  const diffs = await engine.diffSession("ses_999");
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].file, "src/index.js");
  assert.equal(diffs[0].additions, 5);
});

test("providers retorna lista de IDs de provedores", async () => {
  const engine = new OpencodeEngine({
    baseUrl: "http://127.0.0.1:4096",
    username: "u",
    password: "p",
    workdir: "C:/",
    log: () => {},
  });
  engine.client.config.providers = async () => ({
    data: {
      providers: [
        { id: "omniroute", models: [{ id: "auto" }] },
        { id: "opencode", models: [{ id: "x-preview" }] },
      ],
    },
  });
  const list = await engine.providers();
  assert.deepEqual(list, ["omniroute/auto", "opencode/x-preview"]);
});

test("providers reconhece modelos retornados como objeto e preserva qualquer provedor", () => {
  assert.deepEqual(providerModelIds([
    { id: "opencode", models: { "mimo-v2.5-free": {}, "nemotron-3-ultra-free": {} } },
    { id: "nvidia", models: { "nvidia/nemotron-3-ultra-550b-a55b": {} } },
    { id: "omniroute", models: { "auto/best-coding": {} } },
  ]), [
    "opencode/mimo-v2.5-free",
    "opencode/nemotron-3-ultra-free",
    "nvidia/nemotron-3-ultra-550b-a55b",
    "omniroute/auto/best-coding",
  ]);
});

test("resolveModelId preserva prefixo que já faz parte do ID do modelo", () => {
  const providers = [
    { id: "opencode", models: { "mimo-v2.5-free": {} } },
    { id: "nvidia", models: { "nvidia/nemotron-3-ultra-550b-a55b": {} } },
  ];

  assert.deepEqual(resolveModelId("opencode/mimo-v2.5-free", providers), {
    providerID: "opencode",
    modelID: "mimo-v2.5-free",
  });
  assert.deepEqual(resolveModelId("nvidia/nemotron-3-ultra-550b-a55b", providers), {
    providerID: "nvidia",
    modelID: "nvidia/nemotron-3-ultra-550b-a55b",
  });
});

test("prompt propaga o erro técnico do OpenCode em vez de reportar modelo vazio", async () => {
  const engine = new OpencodeEngine({
    baseUrl: "http://127.0.0.1:4096",
    username: "u",
    password: "p",
    workdir: "C:/",
    log: () => {},
  });
  engine.client.session.prompt = async () => ({
    response: { status: 500 },
    error: { name: "UnknownError", data: { message: "falha real do provedor" } },
  });

  await assert.rejects(
    () => engine.prompt("ses_erro", "oi", { modelOverride: "nvidia/model" }),
    /falha real do provedor/,
  );
});
