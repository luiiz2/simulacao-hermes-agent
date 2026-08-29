import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTemporaryFiles, mimeTypeForFile } from "../src/files.mjs";

test("mimeTypeForFile preserva tipos comuns de anexos", () => {
  assert.equal(mimeTypeForFile("script.py"), "text/x-python");
  assert.equal(mimeTypeForFile("data.json"), "application/json");
  assert.equal(mimeTypeForFile("foto.jpg"), "image/jpeg");
  assert.equal(mimeTypeForFile("arquivo.unknown"), "application/octet-stream");
});

test("cleanupTemporaryFiles remove somente arquivos dentro do diretório temporário", async () => {
  const dir = join(tmpdir(), `gateway-files-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const tempFile = join(dir, "download.txt");
  const outsideFile = join(process.cwd(), `.gateway-test-${Date.now()}.txt`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(tempFile, "temporary");
  writeFileSync(outsideFile, "keep");

  try {
    const removed = await cleanupTemporaryFiles([tempFile, outsideFile]);
    assert.equal(removed, 1);
    assert.equal(existsSync(tempFile), false);
    assert.equal(existsSync(outsideFile), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideFile, { force: true });
  }
});
