import { test } from "node:test";
import assert from "node:assert/strict";
import { findMatchingProjects, getAvailableProjects, cleanProjectName } from "../src/projects.mjs";

test("findMatchingProjects filtra e ordena por relevância (exato > prefixo > substring)", () => {
  const list = [
    "C:/Users/Dell/Documents/outro-projeto-agent",
    "C:/Users/Dell/Documents/agent",
    "C:/Users/Dell/Documents/agent-gateway",
    "D:/Workspace/projeto-mobile",
  ];

  // "agent" deve ter como 1º lugar a pasta com nome exato "agent", 2º "agent-gateway", 3º "outro-projeto-agent"
  const res1 = findMatchingProjects("agent", list);
  assert.equal(res1.length, 3);
  assert.equal(res1[0], "C:/Users/Dell/Documents/agent");
  assert.equal(res1[1], "C:/Users/Dell/Documents/agent-gateway");
  assert.equal(res1[2], "C:/Users/Dell/Documents/outro-projeto-agent");

  const res2 = findMatchingProjects("PROJETO", list);
  assert.equal(res2.length, 2);

  const res3 = findMatchingProjects("inexistente", list);
  assert.equal(res3.length, 0);

  const res4 = findMatchingProjects("", list);
  assert.equal(res4.length, 4);
});

test("getAvailableProjects inclui workspace atual, projetos existentes e extraDirs", () => {
  const current = process.cwd();
  const available = getAvailableProjects([current], current, [current]);
  assert.ok(available.length >= 1);
  assert.ok(available.some((p) => p.toLowerCase().includes("simulacao-hermes-agent") || p === current));
});

test("cleanProjectName extrai o nome base da pasta ou Geral", () => {
  assert.equal(cleanProjectName("C:/Users/Dell/Documents/meu-app"), "meu-app");
  assert.equal(cleanProjectName("C:\\Users\\Dell\\Documents\\outro-projeto"), "outro-projeto");
  assert.equal(cleanProjectName(null), "Geral");
});
