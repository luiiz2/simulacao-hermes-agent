// Attachment metadata and safe cleanup for files downloaded to the OS temp dir.

import { unlink } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const MIME_TYPES = {
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".csv": "text/csv",
  ".css": "text/css",
  ".html": "text/html",
  ".htm": "text/html",
  ".ini": "text/plain",
  ".java": "text/x-java-source",
  ".js": "text/javascript",
  ".json": "application/json",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".sql": "application/sql",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

export function mimeTypeForFile(fileName) {
  const ext = extname(String(fileName || "")).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

export async function cleanupTemporaryFiles(paths, root = tmpdir()) {
  const rootPath = resolve(root);
  let removed = 0;
  for (const value of new Set(paths || [])) {
    if (!value) continue;
    const filePath = resolve(String(value));
    const rel = relative(rootPath, filePath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    try {
      await unlink(filePath);
      removed++;
    } catch (error) {
      if (error?.code !== "ENOENT") continue;
    }
  }
  return removed;
}
