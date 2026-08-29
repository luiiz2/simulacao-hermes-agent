import { test } from "node:test";
import assert from "node:assert/strict";
import { RecentDeduplicator } from "../src/dedup.mjs";

test("deduplicação usa messageId e não descarta textos iguais legítimos", () => {
  const d = new RecentDeduplicator();
  const base = { channel: "telegram", userId: "1", text: "status" };
  assert.equal(d.has({ ...base, messageId: 10 }), false);
  assert.equal(d.has({ ...base, messageId: 11 }), false);
  assert.equal(d.has({ ...base, messageId: 10 }), true);
});

test("deduplicação faz fallback para conteúdo quando não há messageId", () => {
  const d = new RecentDeduplicator();
  const message = { channel: "instagram", userId: "ig-1", text: "oi" };
  assert.equal(d.has(message), false);
  assert.equal(d.has(message), true);
  assert.equal(d.has({ ...message, userId: "ig-2" }), false);
});
