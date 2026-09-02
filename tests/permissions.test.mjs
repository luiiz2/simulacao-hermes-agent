import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPermissionAskedEvent,
  normalizePermissionId,
  permissionMarkup,
  selectPendingPermission,
} from "../src/permissions.mjs";

const target = { channel: "telegram", chatId: "42" };

test("aprovação sem ID seleciona a única permissão pendente do chat", () => {
  const pending = new Map([
    ["perm_one", { sessionID: "ses_1", channel: "telegram", chatId: "42", ts: 900 }],
  ]);

  const result = selectPendingPermission(pending, "", target, 1_000);

  assert.equal(result.status, "found");
  assert.equal(result.id, "perm_one");
  assert.equal(result.inferred, true);
  assert.equal(result.entry.sessionID, "ses_1");
});

test("aprovação sem ID não escolhe entre várias permissões", () => {
  const pending = new Map([
    ["perm_one", { sessionID: "ses_1", channel: "telegram", chatId: "42", ts: 900 }],
    ["perm_two", { sessionID: "ses_2", channel: "telegram", chatId: "42", ts: 900 }],
  ]);

  const result = selectPendingPermission(pending, "", target, 1_000);

  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.ids, ["perm_one", "perm_two"]);
});

test("seleção explícita normaliza markdown e ignora outro chat apenas no modo implícito", () => {
  const pending = new Map([
    ["perm_one", { sessionID: "ses_1", channel: "telegram", chatId: "99", ts: 900 }],
  ]);

  assert.equal(normalizePermissionId(" `perm_one` "), "perm_one");
  assert.equal(selectPendingPermission(pending, "", target, 1_000).status, "missing");
  assert.equal(selectPendingPermission(pending, " `perm_one` ", target, 1_000).status, "found");
});

test("permissão oferece botões de aprovar e negar", () => {
  assert.deepEqual(permissionMarkup("perm_one"), {
    inline_keyboard: [[
      { text: "✅ Aprovar", callback_data: "perm:perm_one:y" },
      { text: "🚫 Negar", callback_data: "perm:perm_one:n" },
    ]],
  });
});

test("somente eventos permission.asked criam uma nova pendência", () => {
  assert.equal(isPermissionAskedEvent("permission.asked"), true);
  assert.equal(isPermissionAskedEvent("permission.v2.asked"), true);
  assert.equal(isPermissionAskedEvent("permission.replied"), false);
  assert.equal(isPermissionAskedEvent("permission.updated"), false);
});
