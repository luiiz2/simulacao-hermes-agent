// Project discovery and search utilities for Agent Gateway
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Returns a list of unique, valid workspace directories collected from:
 * 1. Known state projects
 * 2. Default workspace
 * 3. Extra directories (e.g. from OpenCode session history)
 * 4. Sibling folders in the parent of defaultWorkspace (e.g. Documents/*)
 */
export function getAvailableProjects(currentProjects = [], defaultWorkspace = process.cwd(), extraDirs = []) {
  const found = new Set();

  // 1. Known projects in state
  for (const p of currentProjects) {
    if (p && typeof p === "string" && existsSync(p)) {
      found.add(resolve(p));
    }
  }

  // 2. Default workspace
  if (defaultWorkspace && existsSync(defaultWorkspace)) {
    found.add(resolve(defaultWorkspace));
  }

  // 3. Extra directories from OpenCode sessions
  for (const d of extraDirs) {
    if (d && typeof d === "string" && existsSync(d)) {
      found.add(resolve(d));
    }
  }

  // 4. Sibling folders in the parent of defaultWorkspace (e.g. Documents/*)
  try {
    const parentDir = dirname(resolve(defaultWorkspace));
    if (existsSync(parentDir)) {
      const entries = readdirSync(parentDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() && !ent.name.startsWith(".") && !ent.name.startsWith("$")) {
          found.add(join(parentDir, ent.name));
        }
      }
    }
  } catch {}

  return Array.from(found);
}

/**
 * Finds matching projects from a list based on a search query.
 * Prioritizes:
 * - Exact folder name match (score 4)
 * - Prefix folder name match (score 3)
 * - Substring in folder name (score 2)
 * - Substring in full path (score 1)
 */
export function findMatchingProjects(query, availableProjects = []) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return availableProjects;

  const matches = [];
  for (const p of availableProjects) {
    const baseName = (p.split(/[\\/]/).pop() || "").toLowerCase();
    const fullPath = p.toLowerCase();
    let score = 0;

    if (baseName === q) {
      score = 4;
    } else if (baseName.startsWith(q)) {
      score = 3;
    } else if (baseName.includes(q)) {
      score = 2;
    } else if (fullPath.includes(q)) {
      score = 1;
    }

    if (score > 0) {
      matches.push({ path: p, score });
    }
  }

  // Sort descending by score, then ascending by path length
  matches.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return matches.map((m) => m.path);
}

/**
 * Returns a human-friendly short name for a project directory.
 */
export function cleanProjectName(path) {
  if (!path) return "Geral";
  return path.split(/[\\/]/).pop() || path;
}
