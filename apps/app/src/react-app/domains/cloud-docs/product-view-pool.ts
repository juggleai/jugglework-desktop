/** 后台产品页池：同一来源账号与组织共用初始化，空闲后释放，不使用额外锁。 */
export function createProductViewPool(options: {
  idleMs: number;
  create: (id: string, key: string, active: () => boolean) => Promise<void>;
  close: (id: string) => Promise<unknown>;
}) {
  type Entry = { id: string; ready: Promise<void>; cancelled: Promise<never>; cancel: () => void; users: number; timer?: ReturnType<typeof setTimeout> };
  const entries = new Map<string, Entry>();
  const remove = (key: string, entry: Entry) => {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    clearTimeout(entry.timer);
    entry.cancel();
    void options.close(entry.id).catch(() => undefined);
  };
  return {
    /** 获取已有页面或等待同一次初始化；使用结束后重新计算空闲时间。 */
    async run<T>(key: string, run: (id: string) => Promise<T>): Promise<T> {
      let entry = entries.get(key);
      if (!entry) {
        let cancel = () => {};
        const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => reject(new Error("cloud_docs_scope_changed")); });
        void cancelled.catch(() => undefined);
        entry = { id: crypto.randomUUID(), ready: Promise.resolve(), cancelled, cancel, users: 0 };
        entries.set(key, entry);
        const created = entry;
        created.ready = options.create(created.id, key, () => entries.get(key) === created).catch(error => { remove(key, created); throw error; });
      }
      clearTimeout(entry.timer);
      entry.users++;
      try {
        await Promise.race([entry.ready, entry.cancelled]);
        if (entries.get(key) !== entry) throw new Error("cloud_docs_scope_changed");
        return await run(entry.id);
      } finally {
        entry.users--;
        if (entries.get(key) === entry && !entry.users) entry.timer = setTimeout(() => remove(key, entry!), options.idleMs);
      }
    },
    /** 撤权或页面失效时只清理对应实例。 */
    invalidate(id: string) { for (const [key, entry] of entries) if (entry.id === id) remove(key, entry); },
    /** 切换组织、账号及退出登录时释放旧页面，迟到的初始化不能重新打开。 */
    clear() { for (const [key, entry] of entries) remove(key, entry); },
  };
}
