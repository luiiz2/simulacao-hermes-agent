import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, newChatState } from "../src/sessionStore.mjs";

const path = () => join(tmpdir(), `gw-test-${Math.random().toString(36).slice(2)}.json`);

test("cria chat com defaults e persiste", () => {
  const p = path();
  const s = new SessionStore(p);
  const c = s.getChat("telegram", "111", "C:/proj");
  assert.equal(c.workspace, null);
  assert.equal(c.projectSelected, true);
  assert.equal(c.mode, null);
  assert.equal(c.modelSelected, false);
  assert.equal(c.sessionId, null);
  s.updateChat("telegram", "111", { sessionId: "ses_1" });

  const s2 = new SessionStore(p); // reload
  assert.equal(s2.getChat("telegram", "111", "C:/proj").sessionId, "ses_1");
});

test("/new reseta sessão mas mantém workspace", () => {
  const s = new SessionStore(path());
  s.getChat("telegram", "222", "C:/orbia");
  s.updateChat("telegram", "222", {
    sessionId: "ses_old",
    workspace: "C:/orbia",
    projectSelected: true,
    modelSelected: true,
    mode: "fast",
  });
  const fresh = s.resetSession("telegram", "222", true);
  assert.equal(fresh.sessionId, null);
  assert.equal(fresh.workspace, "C:/orbia");
  assert.equal(fresh.projectSelected, true);
  assert.equal(fresh.modelSelected, true);
  assert.equal(fresh.mode, "fast");
});

test("chats ficam isolados por canal+usuário", () => {
  const s = new SessionStore(path());
  s.updateChat("telegram", "1", { sessionId: "a" });
  s.updateChat("instagram", "1", { sessionId: "b" });
  assert.notEqual(s.getChat("telegram", "1", "").sessionId, s.getChat("instagram", "1", "").sessionId);
});

test("novo chat começa sem projeto e aguarda o modelo", () => {
  const c = newChatState(null);
  assert.equal(c.workspace, null);
  assert.equal(c.projectSelected, true);
  assert.equal(c.mode, null);
  assert.equal(c.modelSelected, false);
});

test("estado antigo com projeto implícito migra para modo geral", () => {
  const p = path();
  const raw = {
    chats: {
      "telegram:333": {
        sessionId: "ses_old",
        workspace: "C:/projeto-antigo",
        mode: "auto",
        modelOverride: null,
      },
    },
  };
  writeFileSync(p, JSON.stringify(raw));
  const s = new SessionStore(p);
  const c = s.getChat("telegram", "333", "C:/projeto-antigo");
  assert.equal(c.workspace, null);
  assert.equal(c.sessionId, null);
  assert.equal(c.projectSelected, true);
  assert.equal(c.modelSelected, false);
});
