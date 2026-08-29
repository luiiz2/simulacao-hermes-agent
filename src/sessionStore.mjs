// Persistent channel→OpenCode session mapping + gateway state.
// Key format: "<channel>:<userId>"

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "./config.mjs";
const STATE_PATH = process.env.GATEWAY_STATE || join(ROOT, "state.json");

const DEFAULTS = () => ({ chats: {}, projects: [], pendingConfirm: {} });

export function newChatState(workspace = null) {
  const configuredMode = String(process.env.DEFAULT_MODE || "").trim().toLowerCase() || null;
  return {
    sessionId: null,
    workspace: workspace ?? null,
    // A conversa começa deliberadamente em modo geral; /project é opcional.
    projectSelected: true,
    mode: configuredMode,
    modelOverride: null,
    modelSelected: Boolean(configuredMode),
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
    if (!this.data.chats[k]) this.data.chats[k] = newChatState(null);
    const chat = this.data.chats[k];
    // Old state files had an implicit project. Start those chats in the
    // neutral workspace and discard only the implicit active session.
    if (chat.projectSelected !== true) {
      chat.workspace = null;
      chat.sessionId = null;
      chat.projectSelected = true;
    }
    if (!Object.hasOwn(chat, "modelSelected")) chat.modelSelected = false;
    return chat;
  }

  updateChat(channel, userId, patch) {
    const k = this.key(channel, userId);
    this.data.chats[k] = { ...this.getChat(channel, userId, ""), ...patch, lastActivity: Date.now() };
    this.save();
    return this.data.chats[k];
  }

  resetSession(channel, userId, keepWorkspace = true) {
    const prev = this.getChat(channel, userId, "");
    const fresh = newChatState(keepWorkspace && prev.projectSelected ? prev.workspace : null);
    fresh.projectSelected = true;
    fresh.mode = prev.mode ?? fresh.mode;
    fresh.modelOverride = prev.modelOverride || null;
    fresh.modelSelected = prev.modelSelected === true || Boolean(fresh.modelOverride);
    this.data.chats[this.key(channel, userId)] = fresh;
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
