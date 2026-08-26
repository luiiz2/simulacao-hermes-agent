import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, newChatState } from "../src/sessionStore.mjs";

const path = () => join(tmpdir(), `gw-test-${Math.random().toString(36).slice(2)}.json`);

test("cria chat com defaults e persiste", () => {
  const p = path();
  const s = new SessionStore(p);
  const c = s.getChat("telegram", "111", "C:/proj");
  assert.equal(c.workspace, "C:/proj");
  assert.equal(c.mode, "auto");
  assert.equal(c.sessionId, null);
  s.updateChat("telegram", "111", { sessionId: "ses_1" });

  const s2 = new SessionStore(p); // reload
  assert.equal(s2.getChat("telegram", "111", "C:/proj").sessionId, "ses_1");
});

test("/new reseta sessão mas mantém workspace", () => {
  const s = new SessionStore(path());
  s.getChat("telegram", "222", "C:/orbia");
  s.updateChat("telegram", "222", { sessionId: "ses_old" });
  const fresh = s.resetSession("telegram", "222", true);
  assert.equal(fresh.sessionId, null);
  assert.equal(fresh.workspace, "C:/orbia");
});

test("chats ficam isolados por canal+usuário", () => {
  const s = new SessionStore(path());
  s.updateChat("telegram", "1", { sessionId: "a" });
  s.updateChat("instagram", "1", { sessionId: "b" });
  assert.notEqual(s.getChat("telegram", "1", "").sessionId, s.getChat("instagram", "1", "").sessionId);
});
