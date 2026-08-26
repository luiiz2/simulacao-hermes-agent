// Persistent channel→OpenCode session mapping + gateway state.
// Key format: "<channel>:<userId>"

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE_PATH = process.env.GATEWAY_STATE || join(ROOT, "state.json");

const DEFAULTS = () => ({ chats: {}, projects: [], pendingConfirm: {} });

export function newChatState(workspace) {
  return {
    sessionId: null,
    workspace,
    mode: process.env.DEFAULT_MODE || "auto",
    modelOverride: null,
    title: null,
    lastActivity: 0,
    lastPrompt: null,
  };
}

export class SessionStore {
  constructor(path = STATE_PATH) {
    this.path = path;
    this.data = DEFAULTS();
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      this.data = { ...DEFAULTS(), ...raw };
    } catch {}
  }

  save() {
    try {
      const tmp = `${this.path}.tmp`;
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      renameSync(tmp, this.path);
    } catch (e) {
      console.error(`state save failed: ${e.message}`);
    }
  }

  key(channel, userId) { return `${channel}:${userId}`; }

  getChat(channel, userId, defaultWorkspace) {
    const k = this.key(channel, userId);
    if (!this.data.chats[k]) this.data.chats[k] = newChatState(defaultWorkspace);
    return this.data.chats[k];
  }

  updateChat(channel, userId, patch) {
    const k = this.key(channel, userId);
    this.data.chats[k] = { ...this.getChat(channel, userId, ""), ...patch, lastActivity: Date.now() };
    this.save();
    return this.data.chats[k];
  }

  resetSession(channel, userId, keepWorkspace = true) {
    const prev = this.getChat(channel, userId, "");
    const fresh = newChatState(keepWorkspace ? prev.workspace : undefined);
    this.data.chats[k(this, channel, userId)] = fresh;
    this.save();
    return fresh;
  }

  touchProject(dir) {
    const list = this.data.projects.filter((p) => p !== dir);
    list.unshift(dir);
    this.data.projects = list.slice(0, 10);
    this.save();
  }
}

function k(_self, channel, userId) { return `${channel}:${userId}`; }
