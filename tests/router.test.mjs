import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canDispatchCallback,
  canDispatchCommand,
  parseCallbackData,
  parseCommand,
} from "../src/router.mjs";

test("parseCommand separa nome e argumentos", () => {
  assert.deepEqual(parseCommand(" /project   hermes "), { name: "project", args: "hermes" });
  assert.deepEqual(parseCommand("/status"), { name: "status", args: "" });
  assert.equal(parseCommand("olá"), null);
});

test("parseCallbackData preserva argumentos separados por dois-pontos", () => {
  assert.deepEqual(parseCallbackData("perm:permission-1:y"), {
    kind: "perm",
    args: ["permission-1", "y"],
  });
  assert.equal(parseCallbackData(""), null);
});

test("callbacks aplicam a mesma permissão dos comandos", () => {
  const adminDef = { perm: "admin" };
  const userDef = { perm: "user" };
  const cfg = { adminUsers: ["admin"] };
  assert.equal(canDispatchCommand(adminDef, "admin", cfg), true);
  assert.equal(canDispatchCommand(adminDef, "user", cfg), false);
  assert.equal(canDispatchCommand(userDef, "user", cfg), true);
});

test("callback exige allowlist além da permissão do comando", () => {
  const cfg = { allowedUsers: ["allowed"], adminUsers: ["admin"] };
  assert.equal(canDispatchCallback({ perm: "user" }, "allowed", cfg), true);
  assert.equal(canDispatchCallback({ perm: "user" }, "unknown", cfg), false);
  assert.equal(canDispatchCallback({ perm: "admin" }, "allowed", cfg), false);
  assert.equal(canDispatchCallback({ perm: "admin" }, "admin", {
    allowedUsers: ["admin"],
    adminUsers: ["admin"],
  }), true);
});
