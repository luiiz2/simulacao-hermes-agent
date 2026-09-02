import { test } from "node:test";
import assert from "node:assert/strict";
import { SerialTaskQueue } from "../src/taskQueue.mjs";

test("fila serializa tarefas do mesmo chat e continua após a primeira", async () => {
  const queue = new SerialTaskQueue();
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const first = queue.enqueue("telegram:42", async () => {
    events.push("first:start");
    await gate;
    events.push("first:end");
    return 1;
  });
  const second = queue.enqueue("telegram:42", async () => {
    events.push("second");
    return 2;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  release();

  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ["first:start", "first:end", "second"]);
  assert.equal(queue.has("telegram:42"), false);
});
