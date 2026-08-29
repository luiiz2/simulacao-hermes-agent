import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadEnv, parseIdList } from "../src/config.mjs";

test("loadEnv carrega valores sem sobrescrever o ambiente existente", () => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-config-"));
  const file = join(dir, ".env");
  writeFileSync(file, "NEW_VALUE=loaded\nQUOTED=\"quoted\"\nEXISTING=from-file\n");
  const target = { EXISTING: "from-process" };

  try {
    loadEnv(file, target);
    assert.equal(target.NEW_VALUE, "loaded");
    assert.equal(target.QUOTED, "quoted");
    assert.equal(target.EXISTING, "from-process");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseIdList normaliza IDs separados por vírgula", () => {
  assert.deepEqual(parseIdList(" 1,2, 1 ,,3 "), ["1", "2", "3"]);
});

test("configuração usa administradores explícitos", () => {
  const cfg = getConfig({
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_ALLOWED_USER_IDS: "111,222",
    TELEGRAM_ADMIN_USER_IDS: "222",
    DEFAULT_WORKSPACE: "C:/workspace",
  });

  assert.deepEqual(cfg.allowedUsers, ["111", "222"]);
  assert.deepEqual(cfg.adminUsers, ["222"]);
  assert.equal(cfg.defaultWorkspace, "C:/workspace");
});

test("configuração mantém primeiro usuário como fallback de compatibilidade", () => {
  const cfg = getConfig({ TELEGRAM_ALLOWED_USER_IDS: "111,222" });
  assert.deepEqual(cfg.adminUsers, ["111"]);
});
