// Serializes work per conversation while allowing independent conversations
// to run at the same time.

export class SerialTaskQueue {
  constructor() {
    this.tasks = new Map();
  }

  enqueue(key, task) {
    if (typeof task !== "function") throw new TypeError("task deve ser uma função");
    const queueKey = String(key);
    const previous = this.tasks.get(queueKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    let tracked;
    tracked = current.finally(() => {
      if (this.tasks.get(queueKey) === tracked) this.tasks.delete(queueKey);
    });
    this.tasks.set(queueKey, tracked);
    return tracked;
  }

  has(key) {
    return this.tasks.has(String(key));
  }
}
