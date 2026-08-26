// JSONL logger with size rotation and secret redaction. Local only.

import { appendFileSync, statSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./sanitize.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const LOG_DIR = process.env.GATEWAY_LOG_DIR || join(ROOT, "logs");
const BASE = "gateway.log";
const MAX_BYTES = 5 * 1024 * 1024;
const BACKUPS = 3;

function rotate() {
  const p = join(LOG_DIR, BASE);
  try {
    if (statSync(p).size < MAX_BYTES) return;
    for (let i = BACKUPS - 1; i >= 1; i--) {
      try { renameSync(join(LOG_DIR, `${BASE}.${i}`), join(LOG_DIR, `${BASE}.${i + 1}`)); } catch {}
    }
    try { renameSync(p, join(LOG_DIR, `${BASE}.1`)); } catch {}
  } catch {}
}

let debug = false;
export function setDebug(v) { debug = !!v; }
export function isDebug() { return debug; }

export function log(level, event, fields = {}) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const rec = { ts: new Date().toISOString(), level, event, ...fields };
    appendFileSync(join(LOG_DIR, BASE), redactSecrets(JSON.stringify(rec)) + "\n");
    rotate();
    if (debug || level === "error") {
      const line = `[${rec.ts}] ${level.toUpperCase()} ${event} ${JSON.stringify(fields)}`;
      debug ? console.log(redactSecrets(line)) : level === "error" && console.error(redactSecrets(line));
    }
  } catch {}
}
