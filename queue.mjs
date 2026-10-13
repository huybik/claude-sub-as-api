export class RequestQueue {
  active = 0;
  waiting = [];
  keys = new Set();

  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`Concurrency must be a positive integer, got ${limit}.`);
    this.limit = limit;
  }

  acquire(signal, key = null) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const entry = { key, resolve, reject, signal };
      entry.abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      this.waiting.push(entry);
      signal.addEventListener('abort', entry.abort, { once: true });
      this.drain();
    });
  }

  start(entry) {
    entry.signal.removeEventListener('abort', entry.abort);
    this.active++;
    if (entry.key) this.keys.add(entry.key);
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true;
      this.active--;
      if (entry.key) this.keys.delete(entry.key);
      this.drain();
    });
  }

  drain() {
    while (this.active < this.limit) {
      // Calls for the same saved session keep their order; independent sessions can proceed.
      const index = this.waiting.findIndex(entry => !entry.key || !this.keys.has(entry.key));
      if (index === -1) return;
      this.start(this.waiting.splice(index, 1)[0]);
    }
  }
}
