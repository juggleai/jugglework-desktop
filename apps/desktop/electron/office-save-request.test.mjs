import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchOfficePageResource,
  handleOfficeSaveRequest,
} from "./office-save-request.mjs";

const origin = "http://127.0.0.1:39999";
const filePath = "/workspace/报告 A.docx";
const request = (path, body) =>
  new Request(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("原生页面保存与 MCP save_file 均交给绑定文档的宿主保存", async () => {
  let saves = 0;
  const host = {
    origin,
    filePath,
    save: async () => {
      saves++;
      return { engineFileId: "actual_A" };
    },
  };
  const local = await handleOfficeSaveRequest(
    request("/localapi/save", { file_id: "page_A" }),
    host,
  );
  assert.equal((await local.json()).file_path, filePath);
  const mcp = await handleOfficeSaveRequest(
    request("/mcp", {
      id: 7,
      params: { name: "save_file", arguments: { file_path: filePath } },
    }),
    host,
  );
  assert.deepEqual((await mcp.json()).result.file_id, "actual_A");
  assert.equal(saves, 2);
});

test("幻灯片提交确认保留原始响应，SDK 吞掉失败后也不能保存旧模型", async () => {
  /** @type {{error: Error | null}} */
  const commit = { error: null };
  let response = Response.json({ code: 0, file_id: "page_A" });
  const host = { origin, kind: "slide", commit, fetch: async () => response };
  const first = await fetchOfficePageResource(
    request("/localapi/commitrevision", {}),
    host,
  );
  assert.equal((await first.json()).code, 0);
  assert.equal(commit.error, null);
  response = Response.json({ code: -1, message: "原生版本冲突" });
  const failed = await fetchOfficePageResource(
    request("/localapi/commitrevision", {}),
    host,
  );
  assert.equal((await failed.json()).code, -1);
  assert.match(commit.error?.message ?? "", /版本冲突/);
  response = Response.json({ code: 0 });
  await fetchOfficePageResource(request("/localapi/commitrevision", {}), host);
  assert.match(commit.error?.message ?? "", /版本冲突/);
});

test("幻灯片提交的 HTTP、格式和连接失败均保留错误，其他页面请求不误标提交失败", async () => {
  for (const response of [
    Response.json({ code: 0 }, { status: 500 }),
    new Response("invalid JSON"),
    Response.json({}),
  ]) {
    const commit = { error: null };
    const host = { origin, kind: "slide", commit, fetch: async () => response };
    await fetchOfficePageResource(
      request("/localapi/commitrevision", {}),
      host,
    );
    assert.ok(commit.error);
  }
  const commit = { error: null };
  const host = {
    origin,
    kind: "slide",
    commit,
    fetch: async () => {
      throw new Error("连接失败");
    },
  };
  await assert.rejects(
    fetchOfficePageResource(request("/localapi/commitrevision", {}), host),
    /连接失败/,
  );
  assert.ok(commit.error);
  for (const overrides of [
    { kind: "doc" },
    { origin: "http://127.0.0.1:12345" },
  ]) {
    const other = { error: null };
    await fetchOfficePageResource(request("/localapi/commitrevision", {}), {
      ...host,
      ...overrides,
      commit: other,
      fetch: async () => Response.json({ code: -1 }),
    });
    assert.equal(other.error, null);
  }
});

test("另存路径、其他格式与原生生命周期不能绕过宿主", async () => {
  let saves = 0;
  const host = {
    origin,
    filePath,
    save: async () => {
      saves++;
      return { engineFileId: "actual_A" };
    },
  };
  for (const args of [
    { file_path: "/another.docx" },
    { output_format: "pdf" },
  ]) {
    const result = await handleOfficeSaveRequest(
      request("/localapi/save", args),
      host,
    );
    assert.equal(result.status, 409);
  }
  for (const name of ["open_file", "close_file", "create_doc", "shutdown"]) {
    const result = await handleOfficeSaveRequest(
      request("/mcp", { id: 1, params: { name, arguments: {} } }),
      host,
    );
    assert.equal((await result.json()).result.isError, true);
  }
  assert.equal(
    (await handleOfficeSaveRequest(request("/localapi/editor/close", {}), host))
      .status,
    409,
  );
  assert.equal(saves, 0);
});

test("宿主保存失败返回真实失败，普通内容请求继续走原页面网络", async () => {
  const host = {
    origin,
    filePath,
    save: async () => {
      throw new Error("disk full");
    },
  };
  const result = await handleOfficeSaveRequest(
    request("/localapi/save", {}),
    host,
  );
  assert.equal(result.status, 409);
  assert.match((await result.json()).message, /disk full/);
  assert.equal(
    await handleOfficeSaveRequest(
      request("/mcp", { params: { name: "doc_insert_text", arguments: {} } }),
      host,
    ),
    null,
  );
  assert.equal(
    await handleOfficeSaveRequest(
      new Request("http://127.0.0.1:12345/localapi/save", { method: "POST" }),
      host,
    ),
    null,
  );
});
