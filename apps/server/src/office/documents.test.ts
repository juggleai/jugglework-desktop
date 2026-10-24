import { afterEach, expect, test } from "bun:test";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileArtifact } from "@jugglework/types/file-artifacts";
import type { OfficeDocumentSession } from "@jugglework/types/office";
import { OfficeDocuments } from "./documents.js";
import { ApiError } from "../errors.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(
  readSelection?: (document: OfficeDocumentSession) => Promise<unknown>,
) {
  const root = await mkdtemp(join(tmpdir(), "jugglework-office-"));
  const editors = new Map<
    string,
    { file_id: string; file_path: string; is_dirty: boolean }
  >();
  const files = new Map<string, FileArtifact>();
  for (const name of [
    "报告 A.docx",
    "报告 B.docx",
    "客户.csv",
    "预算.xlsx",
    "汇报.pptx",
  ]) {
    await writeFile(join(root, name), "saved");
    files.set(name, {
      artifactId: `af_${name}`,
      workspaceId: "ws",
      relativePath: name,
      name,
      kind: "document",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 5,
      updatedAt: 1,
      exists: true,
      editingOwner: "internal",
    });
  }
  const state = {
    contentReady: true,
    failSave: false,
    stayDirty: false,
    busy: false,
    blocker: null as "running" | "finalizing" | null,
    transferChecks: [] as string[][],
    sheetCount: 1,
    slideOpen: true,
    availableTools: [
      "create_doc",
      "create_slide",
      "save_file",
      "doc_get_last_operable_pos",
      "sheet_get_sheet_info",
      "sheet_delete_dimension",
      "slide_get_info",
      "open_file",
      "doc_batch_execute",
    ],
    failCreateSave: false,
    createSaveGate: undefined as (() => Promise<void>) | undefined,
    createdTemporaryPaths: [] as string[],
    createSaveTargets: [] as string[],
    createdSequence: 0,
    toolCalls: [] as string[],
    saveCalls: [] as string[],
    saveGate: undefined as (() => Promise<void>) | undefined,
    prepareSave: undefined as (() => Promise<void>) | undefined,
    queryGate: undefined as (() => Promise<void>) | undefined,
    previewGate: undefined as (() => Promise<void>) | undefined,
    checkFile: undefined as ((path: string) => Promise<void>) | undefined,
    closes: [] as Array<{ id: string; discard: boolean }>,
    modified: [] as unknown[][],
    saved: [] as string[],
  };
  const engine = {
    capabilities: async () => ({ available: true, formats: ["docx"] }),
    ensureStarted: async () => {},
    previewUrl: async (path: string) => {
      await state.previewGate?.();
      return `http://127.0.0.1:39999/static/doc/pc.html?localFilePath=${encodeURIComponent(path)}`;
    },
    editor: async (path: string) => editors.get(path) ?? null,
    save: async (id: string) => {
      state.saveCalls.push(id);
      await state.saveGate?.();
      if (state.failSave) throw new Error("disk full");
      const editor = [...editors.values()].find(
        (editor) => editor.file_id === id,
      )!;
      await writeFile(editor.file_path, "actual model content");
      editor.is_dirty = state.stayDirty;
    },
    close: async (id: string, discard = false) => {
      state.closes.push({ id, discard });
      for (const [path, editor] of editors)
        if (editor.file_id === id) editors.delete(path);
    },
    listTools: async () =>
      state.availableTools.map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object" },
      })),
    tool: async (name: string, args: Record<string, unknown> = {}) => {
      state.toolCalls.push(name);
      await state.queryGate?.();
      if (name === "create_doc" || name === "create_slide") {
        const temporaryPath = join(root, `${name}-${state.createdSequence++}.tmp`);
        await writeFile(temporaryPath, "temporary model");
        state.createdTemporaryPaths.push(temporaryPath);
        return { file_id: `created_${name}`, file_path: temporaryPath };
      }
      if (name === "save_file") {
        const target = String(args.file_path);
        state.createSaveTargets.push(target);
        await writeFile(target, "partial model");
        await state.createSaveGate?.();
        if (state.failCreateSave) throw new Error("create save failed");
        return { success: true };
      }
      if (!state.contentReady) throw new Error("model still importing");
      if (name === "slide_get_info")
        return { is_open: state.slideOpen, slide_count: 2 };
      return name === "sheet_get_sheet_info"
        ? {
            sheets: Array.from({ length: state.sheetCount }, (_, index) => ({
              sheet_id: `sheet_${index}`,
            })),
          }
        : { position: 10 };
    },
    dispose: async () => {},
  };
  const documents = new OfficeDocuments({
    engine,
    readSelection,
    checkFile: async (path) => {
      await state.checkFile?.(path);
    },
    prepareSave: async () => {
      await state.prepareSave?.();
    },
    resolveFile: async (_workspace, path) => {
      const file = files.get(path) ?? {
        ...files.get("报告 A.docx")!,
        artifactId: `af_${path}`,
        relativePath: path,
        name: path.split("/").at(-1) ?? path,
        sizeBytes: 0,
        updatedAt: 0,
        exists: false,
      };
      files.set(path, file);
      return { absolutePath: join(root, path), file, workspaceRoot: root };
    },
    onSaved: async (_workspace, path) => {
      state.saved.push(path);
      files.get(path)!.exists = true;
    },
    onModified: async (...args) => {
      state.modified.push(args);
    },
    isBusy: () => state.busy,
    activityBlocker: async (...args) => {
      state.transferChecks.push(args);
      return state.blocker;
    },
    onOwnership: async (_workspace, path, owner) => {
      files.get(path)!.editingOwner = owner;
    },
  });
  cleanups.push(async () => {
    await documents.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const mount = (name: string, id: string) =>
    editors.set(join(root, name), {
      file_id: id,
      file_path: join(root, name),
      is_dirty: false,
    });
  const openReady = async (
    name = "报告 A.docx",
    id = "model_A",
    session = "ses_A",
  ) => {
    const document = await documents.open("ws", session, name);
    mount(name, id);
    return documents.get("ws", document.documentId);
  };
  return { root, documents, state, files, editors, mount, openReady };
}

test("创建 DOCX 和 PPTX 使用真实格式工具，PPTX is_open 后才保存并通过正常生命周期打开", async () => {
  const f = await fixture();
  expect(await f.documents.create("ws", "ses_A", "新文档.docx")).toMatchObject({
    relativePath: "新文档.docx",
    state: "opening",
  });
  f.state.slideOpen = false;
  let slideQueries = 0;
  f.state.queryGate = async () => {
    if (f.state.toolCalls.at(-1) === "slide_get_info" && ++slideQueries === 2)
      f.state.slideOpen = true;
  };
  expect(await f.documents.create("ws", "ses_A", "新演示.pptx")).toMatchObject({
    relativePath: "新演示.pptx",
    state: "opening",
  });
  expect(f.state.toolCalls).toEqual([
    "create_doc",
    "doc_get_last_operable_pos",
    "save_file",
    "create_slide",
    "slide_get_info",
    "slide_get_info",
    "save_file",
  ]);
  expect(f.state.saved).toEqual(["新文档.docx", "新演示.pptx"]);
  expect(f.state.closes).toEqual([
    { id: "created_create_doc", discard: true },
    { id: "created_create_slide", discard: true },
  ]);
});

test("创建在工具缺失、目标已存在或格式不支持时不建立模型或覆盖文件", async () => {
  const f = await fixture();
  f.state.availableTools = f.state.availableTools.filter((name) => name !== "create_slide");
  await expect(
    f.documents.create("ws", "ses_A", "不可用.pptx"),
  ).rejects.toMatchObject({ code: "office_creation_unavailable" });
  await expect(
    f.documents.create("ws", "ses_A", "报告 A.docx"),
  ).rejects.toMatchObject({ code: "file_exists" });
  await expect(
    f.documents.create("ws", "ses_A", "表格.xlsx"),
  ).rejects.toMatchObject({ code: "office_format_unavailable" });
  expect(f.state.toolCalls).toEqual([]);
  expect(await readFile(join(f.root, "报告 A.docx"), "utf8")).toBe("saved");
});

test("创建保存失败会关闭临时模型并清理目标和 SDK 临时文件", async () => {
  const f = await fixture();
  f.state.failCreateSave = true;
  await expect(
    f.documents.create("ws", "ses_A", "失败.pptx"),
  ).rejects.toThrow("create save failed");
  expect(f.state.closes).toEqual([
    { id: "created_create_slide", discard: true },
  ]);
  await expect(access(join(f.root, "失败.pptx"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(access(f.state.createdTemporaryPaths[0]!)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(f.state.saved).toEqual([]);
});

test("创建拒绝解析到工作区外的 symlink 父目录", async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "jugglework-office-outside-"));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(f.root, "外部目录"), "dir");

  await expect(
    f.documents.create("ws", "ses_A", "外部目录/越界.pptx"),
  ).rejects.toMatchObject({ code: "path_escape" });
  await expect(access(join(outside, "越界.pptx"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(f.state.toolCalls).toEqual([]);
});

test("引擎失败期间外部创建最终文件不会被清理", async () => {
  const f = await fixture();
  const target = join(f.root, "竞态.pptx");
  f.state.failCreateSave = true;
  f.state.createSaveGate = async () => {
    await writeFile(target, "external content", { flag: "wx" });
  };

  await expect(
    f.documents.create("ws", "ses_A", "竞态.pptx"),
  ).rejects.toThrow("create save failed");
  expect(await readFile(target, "utf8")).toBe("external content");
  await expect(access(f.state.createSaveTargets[0]!)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(f.state.saved).toEqual([]);
});

test("两个并发创建同一路径仅发布一个且不互相清理", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    f.documents.create("ws", "ses_A", "并发.pptx"),
    f.documents.create("ws", "ses_A", "并发.pptx"),
  ]);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected");
  expect(rejected).toMatchObject({
    status: "rejected",
    reason: { code: "file_exists" },
  });
  expect(await readFile(join(f.root, "并发.pptx"), "utf8")).toBe(
    "partial model",
  );
  for (const path of f.state.createSaveTargets)
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.state.saved).toEqual(["并发.pptx"]);
});

test("系统打开按真实路径和硬链接复用模型，其他工作区及聊天不能建立第二个写模型", async () => {
  const f = await fixture();
  const opened = await f.openReady();
  const alias = "别名.docx";
  await link(join(f.root, opened.name), join(f.root, alias));
  f.files.set(alias, {
    ...f.files.get(opened.name)!,
    artifactId: "alias",
    relativePath: alias,
  });
  expect(
    (await f.documents.findByAbsolutePath(join(f.root, alias)))?.documentId,
  ).toBe(opened.documentId);
  expect((await f.documents.open("ws", "ses_A", alias)).documentId).toBe(
    opened.documentId,
  );
  await expect(
    f.documents.open("other-workspace", "ses_A", alias),
  ).rejects.toMatchObject({ code: "office_document_in_use" });
  await expect(
    f.documents.open("ws", "other-session", alias),
  ).rejects.toMatchObject({ code: "office_document_in_use" });
});

test("旧文件目录失效不阻断无关文件打开及副本检查，旧身份的硬链接仍禁止另建模型或覆盖", async () => {
  const f = await fixture();
  const directory = join(f.root, "旧目录");
  await mkdir(directory);
  const path = "旧目录/原文档.docx";
  await writeFile(join(f.root, path), "old content");
  f.files.set(path, {
    ...f.files.get("报告 A.docx")!,
    artifactId: path,
    relativePath: path,
    name: "原文档.docx",
  });
  const original = await f.openReady(path);
  const alias = "原文件硬链接.docx";
  await link(join(f.root, path), join(f.root, alias));
  f.files.set(alias, {
    ...f.files.get(path)!,
    artifactId: alias,
    relativePath: alias,
    name: alias,
  });
  await rm(directory, { recursive: true });
  await writeFile(directory, "directory replaced by a file");

  expect((await f.documents.open("ws", "ses_A", "报告 B.docx")).state).toBe(
    "opening",
  );
  await f.documents.assertCopyTargetAllowed(join(f.root, "新副本.docx"));
  await expect(f.documents.open("ws", "ses_A", alias)).rejects.toMatchObject({
    code: "office_file_identity_unavailable",
  });
  await expect(
    f.documents.assertCopyTargetAllowed(join(f.root, alias)),
  ).rejects.toMatchObject({ code: "office_file_identity_unavailable" });
  expect(await readFile(join(f.root, alias), "utf8")).toBe("old content");
  await f.documents.close("ws", original.documentId, "discard");
  expect((await f.documents.open("ws", "ses_A", alias)).state).toBe("opening");
});

test("只读文件在创建模型前被拒绝且清空旧 AI 目标，保存和故障恢复同样检查原文件", async () => {
  const f = await fixture();
  const original = await f.openReady();
  const rejected = new ApiError(409, "office_readonly_required", "仅支持预览");
  let previews = 0;
  f.state.previewGate = async () => {
    previews++;
  };
  f.state.checkFile = async () => {
    throw rejected;
  };
  await expect(f.documents.open("ws", "ses_A", "预算.xlsx")).rejects.toBe(
    rejected,
  );
  expect(previews).toBe(0);
  expect(await f.documents.current("ws", "ses_A")).toBeNull();
  await expect(
    f.documents.beforeTool("ws", "ses_A", "doc_replace_text", {
      file_id: original.engineFileId,
    }),
  ).rejects.toMatchObject({ code: "office_not_ready" });
  expect((await f.documents.get("ws", original.documentId)).state).toBe(
    "ready",
  );
  await expect(f.documents.save("ws", original.documentId)).rejects.toBe(
    rejected,
  );
  expect(f.state.saveCalls).toEqual([]);
  f.documents.failPage("ws", original.documentId);
  await expect(f.documents.recover("ws", original.documentId)).rejects.toBe(
    rejected,
  );
  expect(f.state.closes).toEqual([]);
  expect(previews).toBe(0);
});

test("页面地址返回后仍须真实内容查询成功才能 ready，重复打开复用文档身份", async () => {
  const f = await fixture();
  const first = await f.documents.open("ws", "ses_A", "报告 A.docx");
  expect(first.state).toBe("opening");
  expect((await f.documents.get("ws", first.documentId)).state).toBe("opening");
  f.mount("报告 A.docx", "actual_A");
  f.state.contentReady = false;
  expect((await f.documents.get("ws", first.documentId)).state).toBe("opening");
  f.state.contentReady = true;
  expect(await f.documents.get("ws", first.documentId)).toMatchObject({
    state: "ready",
    engineFileId: "actual_A",
  });
  expect(
    (await f.documents.open("ws", "ses_A", "报告 A.docx")).documentId,
  ).toBe(first.documentId);
});

test("实时选区失败返回空，读取期间切换文档或恢复模型不返回旧坐标", async () => {
  const value = {
    ranges: [{ begin: 1, end: 4, length: 3 }],
    selectedText: "选中文字",
  };
  let read: (document: OfficeDocumentSession) => Promise<unknown> = async () =>
    value;
  const calls: OfficeDocumentSession[] = [];
  const f = await fixture(async (document) => {
    calls.push(document);
    return read(document);
  });
  const a = await f.openReady("报告 A.docx", "actual_A");
  expect((await f.documents.context("ws", "ses_A")).selection?.data).toEqual({
    ranges: value.ranges,
    description: "选中文字",
  });
  expect(calls[0]).toMatchObject({
    workspaceId: "ws",
    documentId: a.documentId,
    pageId: a.pageId,
    engineFileId: "actual_A",
  });
  read = async () => {
    throw new Error("页面不可用");
  };
  expect((await f.documents.context("ws", "ses_A")).selection).toBeNull();
  read = async () => ({ ranges: "invalid" });
  expect((await f.documents.context("ws", "ses_A")).selection).toBeNull();
  read = async () => {
    await f.openReady("报告 B.docx", "actual_B");
    return value;
  };
  expect(await f.documents.context("ws", "ses_A")).toMatchObject({
    document: { engineFileId: "actual_B" },
    selection: null,
  });
  f.documents.updateContext("ws", a.documentId, a.pageId, true);
  read = async () => {
    f.documents.failPage("ws", a.documentId);
    await f.documents.recover("ws", a.documentId);
    f.mount("报告 A.docx", "recovered_A");
    return value;
  };
  expect(await f.documents.context("ws", "ses_A")).toMatchObject({
    document: { engineFileId: "recovered_A" },
    selection: null,
  });
  const count = calls.length;
  expect(await f.documents.context("ws", "ses_other")).toEqual({
    document: null,
    selection: null,
  });
  expect(calls).toHaveLength(count);
});

test("按需工具目录只提供当前格式，语义调用绑定真实模型并登记修改，生命周期仍拒绝", async () => {
  const f = await fixture();
  const document = await f.openReady("客户.csv", "sheet_actual");
  const list = await f.documents.tools("ws", "ses_A");
  expect(list).toEqual({
    tools: [
      { name: "sheet_get_sheet_info", description: "sheet_get_sheet_info" },
      { name: "sheet_delete_dimension", description: "sheet_delete_dimension" },
    ],
  });
  expect(JSON.stringify(list)).not.toContain("inputSchema");
  expect(
    await f.documents.tools("ws", "ses_A", "sheet_delete_dimension"),
  ).toMatchObject({
    tool: { name: "sheet_delete_dimension", inputSchema: { type: "object" } },
  });
  await expect(
    f.documents.tools("ws", "ses_A", "doc_get_last_operable_pos"),
  ).rejects.toThrow("内容通道");
  await expect(f.documents.tools("ws", "ses_other")).rejects.toThrow("就绪");
  await f.documents.call("ws", "ses_A", "msg_A", "sheet_get_sheet_info", {});
  expect(f.state.modified).toHaveLength(0);
  await f.documents.call("ws", "ses_A", "msg_A", "sheet_delete_dimension", {
    sheet_id: "sheet_A",
    dimension_type: "row",
    index: 0,
    count: 1,
  });
  expect(f.state.modified[0]).toEqual([
    "ws",
    "ses_A",
    "msg_A",
    expect.any(String),
    document.documentId,
    "客户.csv",
  ]);
  await expect(
    f.documents.call("ws", "ses_A", "msg_A", "save_file", {}),
  ).rejects.toThrow("生命周期");
  await expect(
    f.documents.call("ws", "ses_A", "msg_A", "sheet_delete_dimension", {
      file_id: "wrong",
    }),
  ).rejects.toThrow("当前聊天");
});

test("内容导入一直失败时超时，而不是永久 opening", async () => {
  const f = await fixture();
  const now = Date.now;
  const document = await f.documents.open("ws", "ses_A", "报告 A.docx");
  f.mount("报告 A.docx", "model_A");
  f.state.contentReady = false;
  await f.documents.get("ws", document.documentId);
  const start = now();
  try {
    Date.now = () => start + 61_000;
    expect(await f.documents.get("ws", document.documentId)).toMatchObject({
      state: "error",
      engineFileId: null,
    });
  } finally {
    Date.now = now;
  }
});

test("未访问的后台标签不计加载超时，页面首次挂载才计时，重复打开不能延长期限", async () => {
  const f = await fixture();
  const now = Date.now;
  let time = now();
  try {
    Date.now = () => time;
    const background = await f.documents.open("ws", "ses_A", "报告 A.docx");
    time += 120_000;
    expect((await f.documents.list())[0]?.state).toBe("opening");
    expect(
      (await f.documents.open("ws", "ses_A", "报告 A.docx")).documentId,
    ).toBe(background.documentId);
    f.documents.updateContext(
      "ws", background.documentId, background.pageId, true,
    );
    expect((await f.documents.get("ws", background.documentId)).state).toBe(
      "opening",
    );
    time += 61_000;
    await f.documents.open("ws", "ses_A", "报告 A.docx");
    expect((await f.documents.get("ws", background.documentId)).state).toBe(
      "error",
    );
    const recovered = await f.documents.recover("ws", background.documentId);
    time += 120_000;
    expect((await f.documents.get("ws", recovered.documentId)).state).toBe(
      "opening",
    );
    f.documents.updateContext("ws", recovered.documentId, recovered.pageId, true);
    f.mount("报告 A.docx", "recovered_A");
    expect((await f.documents.get("ws", recovered.documentId)).state).toBe("ready");
  } finally {
    Date.now = now;
  }
});

test("从未加载的后台标签可关闭且不写盘，已开始加载的页面仍阻止提前保存关闭", async () => {
  const f = await fixture();
  const queued = await f.documents.open("ws", "ses_A", "报告 A.docx");
  expect((await f.documents.close("ws", queued.documentId, "save")).state).toBe(
    "closed",
  );
  expect(f.state.saveCalls).toEqual([]);
  const loading = await f.documents.open("ws", "ses_A", "报告 B.docx");
  f.documents.updateContext("ws", loading.documentId, loading.pageId, true);
  await expect(
    f.documents.close("ws", loading.documentId, "save"),
  ).rejects.toMatchObject({ code: "office_not_ready" });
});

test("当前文档按聊天隔离，关闭非当前标签的查询不改变 Agent 目标", async () => {
  const f = await fixture();
  await f.openReady();
  const second = await f.openReady("报告 B.docx", "model_B");
  await f.documents.find("ws", "ses_A", "报告 A.docx");
  expect((await f.documents.current("ws", "ses_A"))?.documentId).toBe(
    second.documentId,
  );
  expect(await f.documents.current("ws", "ses_other")).toBeNull();
  await expect(
    f.documents.open("ws", "ses_other", "报告 A.docx"),
  ).rejects.toThrow("另一聊天");
});

test("Agent 不得绕过宿主生命周期或改写其他模型，缺省 ID 使用实际当前模型", async () => {
  const f = await fixture();
  await f.openReady();
  expect(
    await f.documents.beforeTool("ws", "ses_A", "doc_insert_text", {
      text: "hello",
    }),
  ).toEqual({ file_id: "model_A", text: "hello" });
  for (const tool of [
    "save_file",
    "open_file",
    "close_file",
    "create_doc",
    "create_slide",
    "shutdown",
    "doc_batch_execute",
    "doc_to_image",
  ])
    await expect(
      f.documents.beforeTool("ws", "ses_A", tool, {}),
    ).rejects.toThrow("生命周期");
  await expect(
    f.documents.beforeTool("ws", "ses_A", "doc_insert_text", {
      file_id: "other",
    }),
  ).rejects.toThrow("不属于");
});

test("工具执行期间切换标签，修改仍登记原模型；查询与失败结果不登记", async () => {
  const f = await fixture();
  const first = await f.openReady();
  const args = await f.documents.beforeTool(
    "ws",
    "ses_A",
    "doc_insert_text",
    {},
  );
  await f.openReady("报告 B.docx", "model_B");
  await f.documents.afterTool(
    "ws",
    "ses_A",
    "msg_A",
    "call_1",
    "doc_insert_text",
    args,
    { code: 0 },
  );
  expect(f.state.modified).toEqual([
    ["ws", "ses_A", "msg_A", "call_1", first.documentId, "报告 A.docx"],
  ]);
  await f.documents.afterTool(
    "ws",
    "ses_A",
    "msg_A",
    "call_2",
    "doc_get_text",
    args,
    {},
  );
  await f.documents.afterTool(
    "ws",
    "ses_A",
    "msg_A",
    "call_3",
    "doc_insert_text",
    args,
    { isError: true },
  );
  await f.documents.afterTool(
    "ws",
    "ses_A",
    "msg_A",
    "call_4",
    "doc_insert_text",
    args,
    {
      content: [
        { type: "text", text: '{"code":-1,"message":"invalid position"}' },
      ],
    },
  );
  expect(f.state.modified).toHaveLength(1);
});

test("保存失败保留模型和 dirty，重试保存同一实际文件且不释放模型", async () => {
  const f = await fixture();
  const doc = await f.openReady();
  f.editors.get(join(f.root, "报告 A.docx"))!.is_dirty = true;
  f.state.failSave = true;
  await expect(f.documents.save("ws", doc.documentId, true)).rejects.toThrow(
    "disk full",
  );
  expect(await f.documents.get("ws", doc.documentId)).toMatchObject({
    dirty: true,
    state: "ready",
    engineFileId: "model_A",
  });
  expect(await readFile(join(f.root, "报告 A.docx"), "utf8")).toBe("saved");
  f.state.failSave = false;
  expect(await f.documents.save("ws", doc.documentId, true)).toMatchObject({
    dirty: false,
    state: "ready",
  });
  expect(await readFile(join(f.root, "报告 A.docx"), "utf8")).toBe(
    "actual model content",
  );
  expect(f.state.saveCalls).toEqual(["model_A", "model_A"]);
  expect(f.state.closes).toEqual([]);
});

test("最终保存仍 dirty 时不确认成功，不回退另一路径", async () => {
  const f = await fixture();
  const doc = await f.openReady();
  f.state.stayDirty = true;
  await expect(f.documents.save("ws", doc.documentId, true)).rejects.toThrow(
    "仍有未保存",
  );
  expect(f.state.saveCalls).toEqual(["model_A", "model_A", "model_A"]);
  expect((await f.documents.get("ws", doc.documentId)).dirty).toBe(true);
});

test("迁移等待所属聊天的宿主运行、引擎运行和交付，空闲时不保存或改变 dirty 模型", async () => {
  const f = await fixture();
  const doc = await f.openReady();
  f.editors.get(join(f.root, "报告 A.docx"))!.is_dirty = true;
  f.state.busy = true;
  expect((await f.documents.transferStatus("ws", doc.documentId)).reason).toBe(
    "running",
  );
  f.state.busy = false;
  for (const blocker of ["running", "finalizing", null] as const) {
    f.state.blocker = blocker;
    expect(
      (await f.documents.transferStatus("ws", doc.documentId)).reason,
    ).toBe(blocker);
  }
  expect(f.state.transferChecks).toEqual(
    Array(3).fill(["ws", "ses_A", doc.documentId]),
  );
  expect((await f.documents.get("ws", doc.documentId)).dirty).toBe(true);
  expect(f.state.saveCalls).toEqual([]);
  expect(f.state.closes).toEqual([]);
  f.documents.invalidate();
  await expect(
    f.documents.transferStatus("ws", doc.documentId),
  ).rejects.toThrow("引擎已退出");
});

test("无宿主 run 的引擎任务及交付仍阻止关闭、导出准备、外部接管和故障恢复", async () => {
  const f = await fixture();
  const doc = await f.openReady();
  for (const blocker of ["running", "finalizing"] as const) {
    f.state.blocker = blocker;
    for (const decision of ["save", "discard"] as const)
      await expect(
        f.documents.close("ws", doc.documentId, decision),
      ).rejects.toThrow("任务结束");
    await expect(
      f.documents.prepareFile("ws", "ses_A", "报告 A.docx"),
    ).rejects.toThrow("任务结束");
    await expect(
      f.documents.external("ws", "ses_A", "报告 A.docx"),
    ).rejects.toThrow("任务结束");
  }
  expect(f.state.saveCalls).toEqual([]);
  expect(f.state.closes).toEqual([]);
  f.documents.failPage("ws", doc.documentId);
  await expect(f.documents.recover("ws", doc.documentId)).rejects.toThrow(
    "任务结束",
  );
  expect(f.state.closes).toEqual([]);
  f.state.blocker = null;
  expect((await f.documents.recover("ws", doc.documentId)).state).toBe(
    "opening",
  );
});

test("存活模型阻止源、目标及父目录修改，关闭后才允许宿主改名", async () => {
  const f = await fixture();
  const doc = await f.openReady();
  for (const paths of [["报告 A.docx"], ["未打开.docx", "报告 A.docx"]])
    expect(() => f.documents.assertFileMutationAllowed("ws", paths)).toThrow(
      "保存并关闭",
    );
  expect(() =>
    f.documents.assertFileMutationAllowed("ws", ["报告 A.docx.backup"]),
  ).not.toThrow();
  expect(() =>
    f.documents.assertFileMutationAllowed("other", ["报告 A.docx"]),
  ).not.toThrow();
  expect(await readFile(join(f.root, "报告 A.docx"), "utf8")).toBe("saved");
  await f.documents.close("ws", doc.documentId, "save");
  expect(() =>
    f.documents.assertFileMutationAllowed("ws", ["报告 A.docx"]),
  ).not.toThrow();
  const file = f.files.get("报告 B.docx")!;
  file.relativePath = "reports/报告 B.docx";
  f.files.set(file.relativePath, file);
  await f.documents.open("ws", "ses_A", file.relativePath);
  expect(() =>
    f.documents.assertFileMutationAllowed("ws", ["reports"]),
  ).toThrow("保存并关闭");
  expect(() =>
    f.documents.assertFileMutationAllowed("ws", ["report"]),
  ).not.toThrow();
});

test("副本目标检查跨聊天保护存活文档及文件别名，关闭后才允许覆盖", async () => {
  const f = await fixture();
  await f.openReady();
  const other = await f.openReady("报告 B.docx", "model_B", "ses_B");
  const target = join(f.root, "报告 B.docx");
  const aliases = [target, join(f.root, "硬链接.docx")];
  await link(target, aliases[1]!);
  if (process.platform !== "win32") {
    aliases.push(join(f.root, "符号链接.docx"));
    await symlink(target, aliases.at(-1)!);
  }
  for (const path of aliases)
    await expect(f.documents.assertCopyTargetAllowed(path)).rejects.toThrow(
      "保存并关闭目标",
    );
  await f.documents.assertCopyTargetAllowed(join(f.root, "新副本.docx"));
  f.documents.failPage("ws", other.documentId);
  await expect(f.documents.assertCopyTargetAllowed(target)).rejects.toThrow(
    "保存并关闭目标",
  );
  expect(await readFile(target, "utf8")).toBe("saved");
  await f.documents.close("ws", other.documentId, "discard");
  for (const path of aliases) await f.documents.assertCopyTargetAllowed(path);
});

test("页面故障仅废弃当前模型身份，阻止晚到保存确认并保留磁盘版本恢复入口", async () => {
  const f = await fixture();
  const doc = await f.openReady();
  const other = await f.openReady("报告 B.docx", "model_B");
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  f.state.saveGate = async () => {
    entered.resolve();
    await finish.promise;
  };
  const saving = f.documents.save("ws", doc.documentId);
  await entered.promise;
  expect(f.documents.failPage("ws", doc.documentId)).toMatchObject({
    documentId: doc.documentId,
    state: "error",
    engineFileId: null,
    previewUrl: null,
  });
  finish.resolve();
  await expect(saving).rejects.toThrow("模型已失效");
  expect(f.state.saved).toEqual([]);
  expect((await f.documents.get("ws", other.documentId)).state).toBe("ready");
  expect((await f.documents.get("ws", doc.documentId)).state).toBe("error");
  expect((await f.documents.recover("ws", doc.documentId)).state).toBe(
    "opening",
  );
  expect(f.state.closes).toEqual([{ id: "model_A", discard: true }]);
});

test("最终保存未返回时迁移等待保存，保存结束后才放行", async () => {
  const f = await fixture();
  const doc = await f.openReady();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  f.state.saveGate = async () => {
    entered.resolve();
    await finish.promise;
  };
  const saving = f.documents.save("ws", doc.documentId, true);
  await entered.promise;
  expect((await f.documents.transferStatus("ws", doc.documentId)).reason).toBe(
    "saving",
  );
  finish.resolve();
  await saving;
  expect(
    (await f.documents.transferStatus("ws", doc.documentId)).reason,
  ).toBeNull();
});

test("关闭取消不写入，任务执行中不关闭，保存失败不销毁，放弃才强制释放", async () => {
  const f = await fixture();
  const doc = await f.openReady();
  expect((await f.documents.close("ws", doc.documentId, "cancel")).state).toBe(
    "ready",
  );
  expect(f.state.saveCalls).toEqual([]);
  f.state.busy = true;
  await expect(
    f.documents.close("ws", doc.documentId, "discard"),
  ).rejects.toThrow("任务结束");
  f.state.busy = false;
  f.state.failSave = true;
  await expect(f.documents.close("ws", doc.documentId, "save")).rejects.toThrow(
    "disk full",
  );
  expect(f.state.closes).toEqual([]);
  expect((await f.documents.close("ws", doc.documentId, "discard")).state).toBe(
    "closed",
  );
  expect(f.state.closes).toEqual([{ id: "model_A", discard: true }]);
});

test("外部接管先保存释放，显式返回且新模型 ready 后才恢复内部写入", async () => {
  const f = await fixture();
  const first = await f.openReady();
  await f.documents.external("ws", "ses_A", "报告 A.docx");
  expect(f.state.saveCalls).toEqual(["model_A"]);
  expect(f.state.closes).toEqual([{ id: "model_A", discard: false }]);
  expect(f.files.get("报告 A.docx")!.editingOwner).toBe("external");
  expect(await f.documents.current("ws", "ses_A")).toBeNull();
  await expect(f.documents.open("ws", "ses_A", "报告 A.docx")).rejects.toThrow(
    "重新载入",
  );
  const next = await f.documents.reopen("ws", "ses_A", "报告 A.docx");
  expect(next.documentId).not.toBe(first.documentId);
  expect(f.files.get("报告 A.docx")!.editingOwner).toBe("external");
  f.mount("报告 A.docx", "new_A");
  expect(await f.documents.get("ws", next.documentId)).toMatchObject({
    state: "ready",
    engineFileId: "new_A",
  });
  expect(f.files.get("报告 A.docx")!.editingOwner).toBe("internal");
});

test("引擎退出后旧模型 ID 失效，禁止继续使用旧坐标", async () => {
  const f = await fixture();
  const doc = await f.openReady();
  f.documents.invalidate();
  expect(await f.documents.get("ws", doc.documentId)).toMatchObject({
    state: "error",
    engineFileId: null,
  });
  await expect(
    f.documents.beforeTool("ws", "ses_A", "doc_insert_text", {}),
  ).rejects.toThrow("就绪");
});

for (const fails of [false, true]) {
  test(`保存${fails ? "失败" : "成功"}响应晚于引擎退出时，不恢复旧模型或确认交付`, async () => {
    const f = await fixture();
    const doc = await f.openReady();
    f.editors.get(join(f.root, "报告 A.docx"))!.is_dirty = true;
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    f.state.saveGate = async () => {
      entered.resolve();
      await finish.promise;
    };
    f.state.failSave = fails;
    const saving = f.documents.save("ws", doc.documentId, true);
    await entered.promise;
    f.documents.invalidate();
    finish.resolve();
    await expect(saving).rejects.toThrow(fails ? "disk full" : "模型已失效");
    expect(await f.documents.get("ws", doc.documentId)).toMatchObject({
      state: "error",
      engineFileId: null,
      previewUrl: null,
      dirty: true,
      error: expect.stringContaining("引擎已退出"),
    });
    expect(f.state.saved).toEqual([]);
  });
}

test("打开页面地址晚于引擎退出时，不返回失效页面", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  f.state.previewGate = async () => {
    entered.resolve();
    await finish.promise;
  };
  const opening = f.documents.open("ws", "ses_A", "报告 A.docx");
  await entered.promise;
  f.documents.invalidate();
  finish.resolve();
  expect(await opening).toMatchObject({ state: "error", previewUrl: null });
});

test("导入就绪查询晚于引擎退出时，不把故障会话改回 ready", async () => {
  const f = await fixture();
  const doc = await f.documents.open("ws", "ses_A", "报告 A.docx");
  f.mount("报告 A.docx", "model_A");
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  f.state.queryGate = async () => {
    entered.resolve();
    await finish.promise;
  };
  const reading = f.documents.get("ws", doc.documentId);
  await entered.promise;
  f.documents.invalidate();
  finish.resolve();
  expect(await reading).toMatchObject({ state: "error", engineFileId: null });
});

test("故障文档显式恢复原文件并保留标签身份，运行中拒绝恢复，其他聊天不能接管", async () => {
  const f = await fixture();
  const doc = await f.openReady();
  f.editors.get(join(f.root, "报告 A.docx"))!.is_dirty = true;
  f.documents.invalidate();
  await expect(
    f.documents.open("ws", "ses_other", "报告 A.docx"),
  ).rejects.toThrow("另一聊天");
  expect((await f.documents.open("ws", "ses_A", "报告 A.docx")).state).toBe(
    "error",
  );
  expect(f.state.closes).toEqual([]);
  f.state.busy = true;
  await expect(f.documents.recover("ws", doc.documentId)).rejects.toThrow(
    "任务结束",
  );
  expect(f.state.closes).toEqual([]);
  f.state.busy = false;
  expect(await f.documents.recover("ws", doc.documentId)).toMatchObject({
    documentId: doc.documentId,
    state: "opening",
    dirty: false,
    engineFileId: null,
  });
  expect(f.state.closes).toEqual([{ id: "model_A", discard: true }]);
  expect(await readFile(join(f.root, "报告 A.docx"), "utf8")).toBe("saved");
  f.mount("报告 A.docx", "recovered_A");
  expect(await f.documents.current("ws", "ses_A")).toMatchObject({
    documentId: doc.documentId,
    state: "ready",
    engineFileId: "recovered_A",
  });
  await expect(
    f.documents.beforeTool("ws", "ses_A", "doc_insert_text", {
      file_id: "model_A",
    }),
  ).rejects.toThrow("不属于");
});

test("CSV 使用表格模型就绪查询、原生保存和所属聊天的 sheet 工具，不能调用 Word 工具", async () => {
  const f = await fixture();
  const opened = await f.documents.open("ws", "ses_A", "客户.csv");
  f.mount("客户.csv", "csv_model");
  f.state.contentReady = false;
  expect((await f.documents.get("ws", opened.documentId)).state).toBe(
    "opening",
  );
  f.state.contentReady = true;
  const ready = await f.documents.get("ws", opened.documentId);
  expect(ready).toMatchObject({ state: "ready", engineFileId: "csv_model" });
  expect(f.state.toolCalls).toContain("sheet_get_sheet_info");
  expect(f.state.toolCalls).not.toContain("doc_get_last_operable_pos");
  expect(
    await f.documents.beforeTool("ws", "ses_A", "sheet_set_cell_value", {}),
  ).toEqual({ file_id: "csv_model" });
  await expect(
    f.documents.beforeTool("ws", "ses_A", "doc_insert_text", {}),
  ).rejects.toThrow("工具类型与当前文档不匹配");
  await f.documents.afterTool(
    "ws",
    "ses_A",
    "msg_csv",
    "call_read",
    "sheet_get_cell_data",
    { file_id: "csv_model" },
    {},
  );
  expect(f.state.modified).toHaveLength(0);
  await f.documents.afterTool(
    "ws",
    "ses_A",
    "msg_csv",
    "call_edit",
    "sheet_set_cell_value",
    { file_id: "csv_model" },
    {},
  );
  expect(f.state.modified[0]).toEqual([
    "ws",
    "ses_A",
    "msg_csv",
    "call_edit",
    opened.documentId,
    "客户.csv",
  ]);
  await f.documents.save("ws", opened.documentId, true);
  expect(f.state.saveCalls).toEqual(["csv_model"]);
  f.state.sheetCount = 2;
  await expect(f.documents.save("ws", opened.documentId)).rejects.toThrow(
    "CSV 仅支持单个工作表",
  );
  expect(f.state.saveCalls).toHaveLength(1);
  expect(await f.documents.get("ws", opened.documentId)).toMatchObject({
    state: "ready",
    error: expect.stringContaining("CSV 仅支持单个工作表"),
  });
});

for (const [path, query, edit] of [
  ["预算.xlsx", "sheet_get_sheet_info", "sheet_set_cell_value"],
  ["汇报.pptx", "slide_get_info", "slide_set_text"],
] as const) {
  test(`${path} 按原生格式查询就绪、编辑、保存，不受 CSV 单表限制`, async () => {
    const f = await fixture();
    f.state.sheetCount = 2;
    const opened = await f.documents.open("ws", "ses_A", path);
    f.mount(path, "native_model");
    if (path.endsWith(".pptx")) {
      f.state.slideOpen = false;
      expect((await f.documents.get("ws", opened.documentId)).state).toBe(
        "opening",
      );
      f.state.slideOpen = true;
    }
    expect((await f.documents.get("ws", opened.documentId)).state).toBe(
      "ready",
    );
    expect(f.state.toolCalls).toContain(query);
    const args = await f.documents.beforeTool("ws", "ses_A", edit, {});
    expect(args.file_id).toBe("native_model");
    await f.documents.afterTool(
      "ws",
      "ses_A",
      "msg_native",
      "call_query",
      query,
      args,
      {},
    );
    expect(f.state.modified).toHaveLength(0);
    await f.documents.afterTool(
      "ws",
      "ses_A",
      "msg_native",
      "call_edit",
      edit,
      args,
      {},
    );
    expect(f.state.modified[0]?.slice(-2)).toEqual([opened.documentId, path]);
    await f.documents.save("ws", opened.documentId, true);
    expect(f.state.saveCalls).toEqual(["native_model"]);
    await expect(
      f.documents.beforeTool("ws", "ses_A", "doc_insert_text", {}),
    ).rejects.toThrow("工具类型与当前文档不匹配");
  });
}

test.each(["报告 A.docx", "客户.csv", "预算.xlsx", "汇报.pptx"])(
  "%s 保存先等待页面输入提交，确认失败或恢复更换模型时不能写盘",
  async (path) => {
    const f = await fixture();
    const opened = await f.documents.open("ws", "ses_A", path);
    f.mount(path, "model_A");
    await f.documents.get("ws", opened.documentId);
    let release!: () => void;
    f.state.prepareSave = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const saving = f.documents.save("ws", opened.documentId, true);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.state.saveCalls).toEqual([]);
    release();
    await saving;
    expect(f.state.saveCalls).toEqual(["model_A"]);
    f.state.prepareSave = async () => {
      throw new Error("页面尚未提交完成");
    };
    await expect(
      f.documents.save("ws", opened.documentId, true),
    ).rejects.toThrow("页面尚未提交完成");
    expect(f.state.saveCalls).toEqual(["model_A"]);
    f.state.prepareSave = async () => {
      f.documents.invalidate();
    };
    await expect(
      f.documents.save("ws", opened.documentId, true),
    ).rejects.toThrow("模型已失效");
    expect(f.state.saveCalls).toEqual(["model_A"]);
  },
);
