import { test } from "node:test";
import assert from "node:assert/strict";
import { missingSelection } from "../src/selection.mjs";

test("permite IA sem escolher projeto porque começa em modo geral", () => {
  assert.equal(missingSelection({ projectSelected: true, modelSelected: true }, "nvidia/model"), null);
});

test("bloqueia IA antes de escolher modelo", () => {
  assert.equal(missingSelection({ projectSelected: true, modelSelected: false }, null), "model");
});

test("permite IA após escolhas explícitas", () => {
  assert.equal(missingSelection({ projectSelected: true, modelSelected: true }, "nvidia/model"), null);
  assert.equal(missingSelection({ projectSelected: true, modelOverride: "mimo/model" }, "mimo/model"), null);
});
