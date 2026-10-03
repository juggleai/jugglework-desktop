type Entry<T> = { expiresAt: number; value: T };

export class ReviewMemoryCache {
  private readonly values = new Map<string, Entry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly maxEntries = 200, private readonly now = () => Date.now()) {}

  async getOrLoad<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<{ value: T; cacheHit: boolean }> {
    const cached = this.values.get(key) as Entry<T> | undefined;
    if (cached && cached.expiresAt > this.now()) {
      this.values.delete(key);
      this.values.set(key, cached);
      return { value: cached.value, cacheHit: true };
    }
    this.values.delete(key);
    const active = this.inflight.get(key) as Promise<T> | undefined;
    if (active) return { value: await active, cacheHit: true };
    const request = load();
    this.inflight.set(key, request);
    try {
      const value = await request;
      this.values.set(key, { expiresAt: this.now() + ttlMs, value });
      while (this.values.size > this.maxEntries) this.values.delete(this.values.keys().next().value!);
      return { value, cacheHit: false };
    } finally {
      this.inflight.delete(key);
    }
  }

  clear(): void {
    this.values.clear();
  }
}
