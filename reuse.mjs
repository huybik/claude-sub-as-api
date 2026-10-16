import { createHash } from 'node:crypto';

// Exact JSON bytes preserve prompt and schema order. No semantic normalization.
export function reuseOptions(headers, path, body, input, backend = 'local', profile = 'default') {
  const nonText = input.messages?.some(message => message.content.some(block => block.type !== 'text'));
  const eligible = !(input.stream || input.save_session || input.session_id || input.tools?.length || nonText);
  const enabled = name => {
    const value = headers[name];
    if (value !== undefined && !['true', 'false'].includes(value)) {
      throw Object.assign(new Error(`${name} must be true or false.`), { status: 400 });
    }
    return value === undefined ? eligible : value === 'true';
  };
  const cache = enabled('x-local-cache'), coalesce = enabled('x-local-coalesce');
  if (!eligible && (cache || coalesce)) {
    throw Object.assign(new Error('Local reuse requires non-streaming, stateless text or JSON requests without tools.'), { status: 400 });
  }
  return { cache, coalesce, key: cache || coalesce ? createHash('sha256').update(backend).update('\0').update(profile).update('\0').update(path).update('\0').update(body).digest('hex') : null };
}

export class ResponseReuse {
  entries = new Map();
  pending = new Map();
  bytes = 0;
  waiters = 0;
  counters = { cache_hits: 0, cache_misses: 0, shared_calls: 0, evictions: 0 };

  constructor({ ttl = 600_000, maxBytes = 32 * 1024 * 1024, maxEntries = 1024 } = {}) {
    Object.assign(this, { ttl, maxBytes, maxEntries });
  }

  remove(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  expire() {
    const now = performance.now();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.remove(key);
  }

  stats() {
    this.expire();
    return { ...this.counters, entries: this.entries.size, bytes: this.bytes, max_bytes: this.maxBytes,
      ttl_seconds: this.ttl / 1000, pending: this.pending.size, waiters: this.waiters };
  }

  async run({ key, cache, coalesce }, signal, work) {
    signal.throwIfAborted();
    if (cache) {
      this.expire();
      const entry = this.entries.get(key);
      if (entry) {
        this.entries.delete(key);
        this.entries.set(key, entry);
        this.counters.cache_hits++;
        return { data: JSON.parse(entry.json), source: 'hit' };
      }
      this.counters.cache_misses++;
    }
    let source = cache || coalesce ? 'miss' : 'bypass';
    let data;
    if (!coalesce) data = await work(signal);
    else {
      let group = this.pending.get(key);
      if (group) {
        this.counters.shared_calls++;
        source = 'shared';
      } else {
        const controller = new AbortController();
        group = { controller, users: 0 };
        this.pending.set(key, group);
        group.promise = Promise.resolve().then(() => work(controller.signal)).finally(() => {
          if (this.pending.get(key) === group) this.pending.delete(key);
        });
      }
      group.users++;
      if (source === 'shared') this.waiters++;
      try {
        data = await new Promise((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          group.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        });
      } finally {
        if (source === 'shared') this.waiters--;
        if (--group.users === 0) {
          if (this.pending.get(key) === group) this.pending.delete(key);
          group.controller.abort();
        }
      }
    }
    signal.throwIfAborted();
    // Never store truncated answers, tool requests, or failures.
    if (cache && data.stop_reason === 'end_turn') {
      const json = JSON.stringify(data), bytes = Buffer.byteLength(json) + key.length;
      if (bytes <= this.maxBytes) {
        this.expire();
        this.remove(key);
        while (this.bytes + bytes > this.maxBytes || this.entries.size >= this.maxEntries) {
          this.remove(this.entries.keys().next().value);
          this.counters.evictions++;
        }
        this.entries.set(key, { json, bytes, expires: performance.now() + this.ttl });
        this.bytes += bytes;
      }
    }
    return { data, source };
  }
}
