import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCloudDocAttachments } from "./cloud-doc-attachments.mjs";

const scope = { sourceServerOrigin: "https://org.test", sourceUserId: "user-a", tenantId: "tenant-a" };

async function fixture(body = "xlsx fixture") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-doc-attachments-"));
  const opened = [];
  const closed = [];
  const requests = [];
  const attachments = createCloudDocAttachments({
    root,
    openReadOnly: async file => { opened.push(file); },
    closeUnder: async directory => { closed.push(directory); },
  });
  const nativeSession = {
    fetch: async url => { requests.push(url); return new Response(body, { status: 200 }); },
  };
  const input = { scope, nativeSession, origin: "https://docs.test", workspaceId: "ws", docId: "doc", blobId: "blob-1", name: "../报告.xlsx" };
  return { root, opened, closed, requests, attachments, input };
}

test("附件经云文档会话下载到范围缓存并只读打开，已缓存时不再下载", async () => {
  const f = await fixture();
  const first = await f.attachments.open(f.input);
  assert.equal(path.basename(first.file), "报告.xlsx");
  assert.equal(await fs.readFile(first.file, "utf8"), "xlsx fixture");
  assert.ok(first.file.startsWith(f.root));
  await f.attachments.open(f.input);
  assert.equal(f.requests.length, 1);
  assert.equal(f.opened.length, 2);
  assert.match(f.requests[0], /\/api\/jw\/session\/attachments\/ws\/doc\/blob-1$/);
});

test("清理范围先关闭只读窗口再删除缓存目录", async () => {
  const f = await fixture();
  const { file } = await f.attachments.open(f.input);
  await f.attachments.clearScope(scope);
  assert.equal(f.closed.length, 1);
  assert.ok(file.startsWith(f.closed[0]));
  await assert.rejects(fs.stat(file));
});

test("非法标识和下载失败不写入缓存", async () => {
  const f = await fixture();
  await assert.rejects(f.attachments.open({ ...f.input, blobId: "../x" }), /cloud_attachment_invalid/);
  f.input.nativeSession.fetch = async () => new Response("no", { status: 403 });
  await assert.rejects(f.attachments.open(f.input), /download_failed:403/);
  assert.equal(f.opened.length, 0);
});

test("下载中撤权取消旧请求，等待任务结束后清缓存，不重新打开旧组织附件", async () => {
  const f = await fixture();
  /** @type {(response: Response) => void} */
  let downloaded = () => { throw new Error("download_not_started"); };
  let started;
  const receiving = new Promise(resolve => { started = resolve; });
  f.input.nativeSession.fetch = async () => {
    started();
    return new Promise(resolve => { downloaded = resolve; });
  };
  const task = f.attachments.open(f.input);
  const rejected = assert.rejects(task, /cloud_attachment_scope_changed/);
  await receiving;
  const cleanup = f.attachments.clearScope(scope);
  downloaded(new Response("late response"));
  await Promise.all([cleanup, rejected]);
  assert.equal(f.opened.length, 0);
  assert.equal(f.closed.length, 1);
  await assert.rejects(fs.stat(f.closed[0]));
  await fs.rm(f.root, { recursive: true, force: true });
});
