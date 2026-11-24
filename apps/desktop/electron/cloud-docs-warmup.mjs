import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

const recentLifetime = 7 * 24 * 60 * 60 * 1000;
const resourceId = /^[a-zA-Z0-9_-]{1,64}$/;
const identityKeys = ["sourceServerOrigin", "sourceUserId", "tenantId"];

function cleanOrigin(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.href !== `${url.origin}/`) return null;
    if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return url.origin;
  } catch { /* 无法归一化的来源没有有效定位。 */ }
  return null;
}

function identity(input) {
  const origin = cleanOrigin(input?.sourceServerOrigin);
  const validId = value => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
  if (!origin || !validId(input.sourceUserId) || !validId(input.tenantId)) return null;
  return { sourceServerOrigin: origin, sourceUserId: input.sourceUserId, tenantId: input.tenantId };
}

/** Main 的最近定位最多一条。只读写白名单字段，独立于业务会话存储。 */
export function createCloudDocsRecent(filePath, now = Date.now) {
  let lastWritten;
  function sanitize(input) {
    const scope = identity(input);
    const docsOrigin = cleanOrigin(input?.docsOrigin);
    const { workspaceId, docId } = input ?? {};
    if (!scope || !docsOrigin || !resourceId.test(workspaceId ?? "") ||
      typeof workspaceId !== "string" || (docId !== null && (typeof docId !== "string" || !resourceId.test(docId)))) return null;
    return { ...scope, docsOrigin, workspaceId, docId };
  }
  return {
    read(scope) {
      const expected = identity(scope);
      if (!expected) return null;
      try {
        const raw = readFileSync(filePath, "utf8");
        if (raw.length > 4096) return null;
        const record = JSON.parse(raw);
        const clean = sanitize(record);
        const age = now() - record.updatedAt;
        return record.version === 1 && record.kind === (clean?.docId === null ? "home" : "page") &&
          typeof record.updatedAt === "number" && age >= 0 && age <= recentLifetime &&
          clean && identityKeys.every(key => clean[key] === expected[key]) ? clean : null;
      } catch { return null; }
    },
    write(input) {
      const clean = sanitize(input);
      if (!clean) return;
      if (lastWritten && now() - lastWritten.updatedAt < 60_000 &&
        Object.keys(clean).every(key => clean[key] === lastWritten[key])) return;
      try {
        const next = { version: 1, kind: clean.docId === null ? "home" : "page", ...clean, updatedAt: now() };
        writeFileSync(`${filePath}.tmp`, JSON.stringify(next), { mode: 0o600 });
        renameSync(`${filePath}.tmp`, filePath);
        lastWritten = next;
      } catch { /* 本机定位失败不影响已打开的页面。 */ }
    },
    clear() {
      lastWritten = undefined;
      for (const file of [filePath, `${filePath}.tmp`]) {
        try { unlinkSync(file); } catch { /* 文件不存在或不可写。 */ }
      }
    },
  };
}

/** 每个进程预热一次，由显式打开决定等待同一实例或清理旧预热。 */
export function createCloudDocsWarmup({ discard, ready, loadTimeoutMs = 30_000, idleTimeoutMs = 120_000 }) {
  let used = false;
  let pending;

  function matches(entry, input) {
    const scope = identity(input);
    return entry && entry.binding === input?.hostBinding && scope && identityKeys.every(key => entry.scope[key] === scope[key]) &&
      entry.authFingerprint === input.authFingerprint;
  }

  function clear(entry, success) {
    if (pending !== entry) return;
    pending = undefined;
    clearTimeout(entry.timer);
    entry.complete(success);
  }

  function expire(entry, duration) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      clear(entry, false);
      void discard(entry.instanceId);
    }, duration);
    entry.timer.unref?.();
  }

  function cancel(cleanup = true) {
    if (!pending) return;
    const { instanceId } = pending;
    clear(pending, false);
    if (cleanup) void discard(instanceId);
  }

  return {
    reserve(input, scope) {
      if (used || !scope || typeof input.authFingerprint !== "string" || !/^\d+:\d+$/.test(input.authFingerprint) || input.authFingerprint.length > 30 ||
        !/^[a-f0-9-]{36}$/i.test(input.hostBinding ?? "")) return null;
      used = true;
      const entry = { instanceId: randomUUID(), binding: input.hostBinding, authFingerprint: input.authFingerprint, scope };
      entry.wait = new Promise(resolve => { entry.complete = resolve; });
      pending = entry;
      expire(entry, loadTimeoutMs);
      return { instanceId: entry.instanceId, docsOrigin: scope.docsOrigin, target: scope.docId
        ? { kind: "page", workspaceId: scope.workspaceId, pageId: scope.docId }
        : { kind: "home" } };
    },
    start(input, origin) {
      if (!pending || pending.instanceId !== input.instanceId || pending.started || !matches(pending, input) || pending.scope.docsOrigin !== origin) return false;
      pending.started = true;
      return true;
    },
    settled(instanceId, success) {
      const entry = pending;
      if (entry?.instanceId !== instanceId) return;
      if (!success) { cancel(); return; }
      if (entry.settled) return;
      entry.settled = true;
      entry.complete(true);
      expire(entry, idleTimeoutMs);
    },
    async claim(input, isTrusted) {
      used = true;
      const entry = pending;
      if (!entry) return null;
      const target = input.target;
      // TIPS: 缺工作区的深链可能同时匹配共享和私有文档，仍交给服务端解析。
      const matchesTarget = !target?.commentId && (entry.scope.docId === null
        ? target?.kind === "home"
        : target?.kind === "page" && target.pageId === entry.scope.docId && target.workspaceId === entry.scope.workspaceId);
      if (!matches(entry, input) || !matchesTarget) { cancel(); return null; }
      if (!await entry.wait || pending !== entry || !isTrusted() || !ready(entry.instanceId, entry.scope)) return null;
      clear(entry, true);
      return entry.instanceId;
    },
    exclude(cleanup) { used = true; cancel(cleanup); },
    cancel,
    cancelBinding(binding, instanceId) {
      if (pending?.binding === binding && (!instanceId || pending.instanceId === instanceId)) cancel();
    },
  };
}
