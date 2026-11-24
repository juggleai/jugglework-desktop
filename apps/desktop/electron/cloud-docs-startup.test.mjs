import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCloudDocsStartup } from "./cloud-docs-startup.mjs";
import { invokeOptionalCloudDocs } from "./cloud-docs-optional-ipc.mjs";
import { createCloudDocsRecent, createCloudDocsWarmup } from "./cloud-docs-warmup.mjs";

const scope = {
  sourceServerOrigin: "https://work.test", sourceUserId: "user", tenantId: "org",
  docsOrigin: "https://docs.test", workspaceId: "scope", docId: null,
};
const actor = () => ({ ...scope, authFingerprint: "20:1234", hostBinding: randomUUID() });

test("热更新遇到旧 Main 时仅回退未注册的可选命令", async () => {
  const channel = "jugglework:docs:resume-candidate";
  const missing = async () => { throw new Error(`Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`); };
  assert.equal(await invokeOptionalCloudDocs(missing, channel, {}, null), null);
  await assert.rejects(() => invokeOptionalCloudDocs(missing, "jugglework:docs:resume", {}, "fallback"), /No handler/);
  await assert.rejects(() => invokeOptionalCloudDocs(async () => { throw new Error("Forbidden"); }, channel, {}, null), /Forbidden/);
});

test("最近定位仅保留当前身份的一条目标，遗漏秘密并在七天后失效", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jw-docs-recent-"));
  const file = join(dir, "recent.json");
  try {
    let time = 10_000;
    const store = createCloudDocsRecent(file, () => time);
    store.write({ ...scope, docId: "doc", launchGrant: "secret", authFingerprint: "token" });
    assert.deepEqual(store.read(scope), { ...scope, docId: "doc" });
    assert.equal(store.read({ ...scope, sourceUserId: "other" }), null);
    assert.equal(store.read({ ...scope, tenantId: "other" }), null);
    assert.doesNotMatch(await readFile(file, "utf8"), /secret|token|authFingerprint|launchGrant/);
    store.write(scope);
    assert.deepEqual(store.read(scope), scope);
    time += 7 * 24 * 60 * 60 * 1000 + 1;
    assert.equal(store.read(scope), null);
    store.clear();
    await assert.rejects(() => readFile(file), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("预热共用单一实例，两个 claim 只能成功接管一次", async () => {
  const discarded = [];
  const controller = createCloudDocsWarmup({ discard: id => discarded.push(id), ready: () => true });
  const requester = actor();
  const ticket = controller.reserve(requester, scope);
  assert(ticket);
  const { instanceId, target, docsOrigin } = ticket;
  assert.equal(controller.start({ ...requester, instanceId }, docsOrigin), true);
  assert.equal(controller.start({ ...requester, instanceId }, docsOrigin), false);
  const first = controller.claim({ ...requester, target }, () => true);
  const duplicate = controller.claim({ ...requester, target }, () => true);
  controller.settled(instanceId, true);
  assert.deepEqual(await Promise.all([first, duplicate]), [instanceId, null]);
  assert.equal(controller.reserve(requester, scope), null);
  assert.deepEqual(discarded, []);
});

test("显式打开先到及身份变化时取消预热，超时释放未使用实例", async () => {
  const discarded = [];
  const requester = actor();
  const create = () => createCloudDocsWarmup({ discard: id => discarded.push(id), ready: () => true, loadTimeoutMs: 10, idleTimeoutMs: 10 });
  const before = create();
  assert.equal(await before.claim({ ...requester, target: { kind: "home" } }, () => true), null);
  assert.equal(before.reserve(requester, scope), null);

  const switched = create();
  const first = switched.reserve(requester, scope);
  assert(first);
  assert.equal(await switched.claim({ ...requester, authFingerprint: "20:5678", target: first.target }, () => true), null);
  assert.equal(switched.start({ ...requester, instanceId: first.instanceId }, scope.docsOrigin), false);

  const idle = create();
  const second = idle.reserve(requester, scope);
  assert(second);
  idle.settled(second.instanceId, true);
  await wait(30);
  assert.deepEqual(discarded, [first.instanceId, second.instanceId]);
});

const document = { targetKind: "document", workspaceId: "ws", docId: "doc" };

test("旧服务和失联观测分别采样", async () => {
  for (const [supported, expected] of [[false, "unsupported"], [true, "unavailable"]]) {
    const requests = [];
    const samples = [];
    const startup = createCloudDocsStartup({
      instanceId: "fixture", send: request => requests.push(request),
      record: sample => samples.push(sample), timeoutMs: 1,
    });
    startup.ready("ctx", document, supported);
    startup.visible();
    await wait(10);
    assert.equal(requests.length, Number(supported));
    assert.equal(samples.length, 1);
    assert.equal(samples[0].outcome, expected);
    if (supported) startup.receive({ ...requests[0], state: "presentable", format: "sheet" }, document);
    assert.equal(samples.length, 1);
  }
});

test("收到 loading 后等待真实正文，隐藏期间不结算可交互耗时", async () => {
  let request;
  let now = 0;
  const samples = [];
  const startup = createCloudDocsStartup({
    instanceId: "fixture", send: value => { request = value; },
    record: sample => samples.push(sample), timeoutMs: 1, now: () => now,
  });
  now = 3;
  startup.ready("ctx", document, true);
  startup.receive({ ...request, state: "loading" }, document);
  await wait(10);
  const done = { ...request, state: "presentable", format: "sheet" };
  now = 9;
  startup.receive({ ...done, contextId: "stale" }, document);
  startup.receive(done, { ...document, docId: "other" });
  assert.equal(samples.length, 0);
  now = 12;
  startup.receive(done, document);
  assert.equal(samples.length, 0);
  now = 18;
  startup.visible();
  assert.deepEqual(samples, [{
    path: "bootstrap", outcome: "presentable", format: "sheet", commandReadyMs: 3,
    firstVisibleMs: 18, contentPresentableMs: 12, nativeElapsedMs: 18,
  }]);
});
