import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAllowedUser,
  isAdminUser,
  sessionBelongsToUser,
  sessionTag,
} from "../src/auth.mjs";

const cfg = {
  allowedUsers: ["111"],
  adminUsers: ["222"],
  instagramAllowedUsers: ["ig-1"],
};

test("autorização usa allowlist separada por canal", () => {
  assert.equal(isAllowedUser("telegram", "111", cfg), true);
  assert.equal(isAllowedUser("telegram", "222", cfg), false);
  assert.equal(isAllowedUser("instagram", "ig-1", cfg), true);
  assert.equal(isAllowedUser("instagram", "111", cfg), false);
});

test("admin não depende da posição na allowlist", () => {
  assert.equal(isAdminUser("222", cfg), true);
  assert.equal(isAdminUser("111", cfg), false);
});

test("sessão pertence ao usuário pelo owner map ou pela tag do título", () => {
  assert.equal(sessionTag("telegram", "111"), "[tg:111]");
  assert.equal(
    sessionBelongsToUser({ id: "s1", title: "[tg:111] [proj] conversa" }, "telegram", "111"),
    true,
  );
  assert.equal(
    sessionBelongsToUser({ id: "s2", title: "[tg:222] outra" }, "telegram", "111"),
    false,
  );

  const owners = new Map([["s3", { channel: "instagram", userId: "ig-1", chatId: "ig-1" }]]);
  assert.equal(sessionBelongsToUser({ id: "s3", title: "[bg] tarefa" }, "instagram", "ig-1", owners), true);
  assert.equal(sessionBelongsToUser({ id: "s3", title: "[bg] tarefa" }, "telegram", "111", owners), false);
});
