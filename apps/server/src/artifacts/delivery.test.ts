import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeAdmissionId } from "../opencode-admission.js";
import { ArtifactRegistry, type ObservedArtifactFile } from "./registry.js";
import {
  artifactPathsFromTool,
  FileDeliveryService,
  type ArtifactEngineMessage,
} from "./delivery.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const origin = { sessionId: "ses_1", turnId: "msg_user_1", runId: "run_1" };
const observed = (size = 10): ObservedArtifactFile => ({
  value: "报告 A.docx",
  name: "报告 A.docx",
  preview: "document",
  exists: true,
  size,
  updatedAt: size,
});
const writePart = (path: string, status = "completed") => ({
  id: `part_${path}`,
  type: "tool",
  tool: "write",
  callID: `call_${path}`,
  state: { status, input: { filePath: path } },
});
const assistant = (parentID = origin.turnId): ArtifactEngineMessage => ({
  info: { id: "msg_assistant_1", role: "assistant", parentID },
  parts: [writePart("报告 A.docx")],
});
async function root() {
  const value = await mkdtemp(join(tmpdir(), "jugglework-delivery-"));
  roots.push(value);
  return value;
}

test("选区轮次的展示和模式标记在重启后保留，同一消息不能改换引用", async () => {
  const path = await root();
  const registry = new ArtifactRegistry("ws_1", path);
  registry.begin(origin);
  const selection = { references: [{ referenceId: "r", kind: "sheet-cells" as const, preview: { name: "数据.xlsx", range: "第二表!A8", text: "" } }],
    instructions: [{ instructionId: "i", text: "改为 10", bindingState: "bound" as const, referenceIds: ["r"] }] };
  registry.recordOfficeSelection(origin, selection);
  registry.recordOfficeSelection(origin, selection);
  expect(() => registry.recordOfficeSelection(origin, { ...selection, references: [] })).toThrow("changed");
  expect(new ArtifactRegistry("ws_1", path).list(origin.sessionId).turns[0].officeSelection).toEqual(selection);
  expect(JSON.stringify(selection)).not.toContain("modelGeneration");
});

test("历史快照在后续轮次修改、事件重放、宿主重命名和重启后保持不变", async () => {
  const path = await root();
  const registry = new ArtifactRegistry("ws_1", path);
  registry.track(origin, {
    key: "write_1",
    source: "tool",
    path: "报告 A.docx",
  });
  registry.finishRun(origin.runId);
  registry.confirm(origin, "write_1", observed(0));
  const second = { ...origin, turnId: "msg_user_2", runId: "run_2" };
  registry.track(second, {
    key: "write_2",
    source: "tool",
    path: "报告 A.docx",
  });
  registry.finishRun(second.runId);
  registry.confirm(second, "write_2", observed(90));
  registry.confirm(origin, "write_1", observed(90));
  registry.rename("报告 A.docx", "报告 B.docx");
  const data = new ArtifactRegistry("ws_1", path).list(origin.sessionId);
  expect(data.files).toHaveLength(1);
  expect(data.files[0]).toMatchObject({
    relativePath: "报告 B.docx",
    sizeBytes: 90,
  });
  expect(data.turns.map((turn) => turn.items[0]?.snapshot)).toEqual([
    { name: "报告 A.docx", sizeBytes: 0, updatedAt: 0 },
    { name: "报告 A.docx", sizeBytes: 90, updatedAt: 90 },
  ]);
});

test("只归集真实父消息的成功写入，失败工具和其他轮次不混入", async () => {
  const path = await root();
  let inspections = 0;
  const own = assistant();
  own.parts.push(writePart("失败.docx", "error"), writePart("src/index.ts"));
  const service = new FileDeliveryService({
    workspace: () => ({ id: "ws_1", path }),
    readMessages: async () => [own, assistant("msg_other")],
    inspect: async () => {
      inspections++;
      return observed(12);
    },
  });
  expect(
    service.preparePrompt("ws_1", origin.sessionId, origin.runId, {
      messageID: origin.turnId,
    }),
  ).toEqual({ messageID: origin.turnId });
  await service.finishRun("ws_1", origin.sessionId, origin.runId);
  const result = await service.list("ws_1", origin.sessionId);
  expect(result.turns[0]).toMatchObject({
    status: "ready",
    turnId: origin.turnId,
  });
  expect(result.turns[0]!.targets).toHaveLength(1);
  expect(result.files[0]!.name).toBe("报告 A.docx");
  expect(inspections).toBe(2);
});

test("自动生成的真实用户消息 ID 在同一 run 重试时保持一致", async () => {
  const path = await root();
  const service = new FileDeliveryService({
    workspace: () => ({ id: "ws_1", path }),
    readMessages: async () => [],
    inspect: async () => null,
  });
  const first = service.preparePrompt("ws_1", origin.sessionId, origin.runId, {
    parts: [],
  });
  expect(first.messageID).toMatch(/^msg_/);
  expect(
    service.preparePrompt("ws_1", origin.sessionId, origin.runId, { parts: [] })
      .messageID,
  ).toBe(first.messageID);
  expect(
    service.preparePrompt("ws_1", origin.sessionId, "run_2", { parts: [] })
      .messageID,
  ).not.toBe(first.messageID);
});

test("Office 工具钩子缺少 messageID 时按 callID 的真实父消息绑定，最终保存仍归原轮次", async () => {
  const path = await root();
  const messages = [
    {
      info: {
        id: "assistant_office",
        role: "assistant",
        parentID: origin.turnId,
      },
      parts: [
        {
          type: "tool",
          callID: "call_word",
          tool: "jugglework-office_doc_insert_text",
        },
      ],
    },
  ];
  const saved: string[] = [];
  const service = new FileDeliveryService({
    workspace: () => ({ id: "ws_1", path }),
    readMessages: async () => messages,
    inspect: async () => observed(40),
    saveTarget: async (_workspace, _origin, target) => {
      saved.push(target.documentId!);
    },
  });
  service.registry("ws_1").begin(origin);
  await service.bindOfficeModification(
    "ws_1",
    origin.sessionId,
    "",
    "call_word",
    "od_A",
    "报告 A.docx",
  );
  await service.bindOfficeModification(
    "ws_1",
    origin.sessionId,
    "",
    "unknown_call",
    "od_wrong",
    "报告 B.docx",
  );
  await service.finishRun("ws_1", origin.sessionId, origin.runId);
  expect(saved).toEqual(["od_A"]);
  const turn = (await service.list("ws_1", origin.sessionId)).turns[0]!;
  expect(turn).toMatchObject({ turnId: origin.turnId, status: "ready" });
  expect(turn.items[0]?.snapshot).toMatchObject({
    name: "报告 A.docx",
    sizeBytes: 40,
  });
  expect(turn.targets).toHaveLength(1);
});

test("Office 必须等待保存成功；保存失败不能发布磁盘上的旧版本，重试只保存和校验", async () => {
  const path = await root();
  let saveCalls = 0;
  let release!: () => void;
  const saved = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  const service = new FileDeliveryService({
    workspace: () => ({ id: "ws_1", path }),
    readMessages: async () => [],
    inspect: async () => observed(31),
    saveTarget: async () => {
      saveCalls++;
      await saved;
      if (fail) throw new Error("保存失败");
    },
  });
  service
    .registry("ws_1")
    .track(origin, { key: "office_1", path: "报告 A.docx", source: "office" });
  const completion = service.finishRun("ws_1", origin.sessionId, origin.runId);
  await Promise.resolve();
  await Promise.resolve();
  expect(
    service.registry("ws_1").list(origin.sessionId).turns[0]?.items,
  ).toHaveLength(0);
  release();
  await completion;
  expect((await service.list("ws_1", origin.sessionId)).turns[0]).toMatchObject(
    { status: "failed", items: [] },
  );
  fail = false;
  expect(
    (await service.retry("ws_1", origin.sessionId, origin.turnId)).turns[0],
  ).toMatchObject({ status: "ready" });
  expect(saveCalls).toBe(2);
  const unsupported = new FileDeliveryService({
    workspace: () => ({ id: "ws_1", path: join(path, "other") }),
    readMessages: async () => [],
    inspect: async () => observed(),
  });
  unsupported
    .registry("ws_1")
    .track(origin, { key: "office", path: "报告 A.docx", source: "office" });
  await unsupported.finishRun("ws_1", origin.sessionId, origin.runId);
  expect(
    (await unsupported.list("ws_1", origin.sessionId)).turns[0],
  ).toMatchObject({ status: "failed", items: [] });
});

test("部分文件失败只重试确认，已交付快照不被更新；运行中不能提前重试", async () => {
  const path = await root();
  let missing = true;
  let reads = 0;
  const service = new FileDeliveryService({
    workspace: () => ({ id: "ws_1", path }),
    readMessages: async () => {
      reads++;
      return [
        {
          ...assistant(),
          parts: [writePart("报告 A.docx"), writePart("报告 B.docx")],
        },
      ];
    },
    inspect: async (_, name) =>
      name === "报告 B.docx" && missing
        ? null
        : { ...observed(16), value: name, name },
  });
  service.preparePrompt("ws_1", origin.sessionId, origin.runId, {
    messageID: origin.turnId,
  });
  await expect(
    service.retry("ws_1", origin.sessionId, origin.turnId),
  ).rejects.toThrow("artifact_run_not_finished");
  await service.finishRun("ws_1", origin.sessionId, origin.runId);
  expect((await service.list("ws_1", origin.sessionId)).turns[0]?.status).toBe(
    "partial",
  );
  missing = false;
  const result = await service.retry("ws_1", origin.sessionId, origin.turnId);
  expect(result.turns[0]?.status).toBe("ready");
  expect(result.turns[0]?.items).toHaveLength(2);
  expect(reads).toBe(1);
});

test("重启后只在引擎空闲时恢复确认，不重复执行写入", async () => {
  const path = await root();
  const options = {
    workspace: () => ({ id: "ws_1", path }),
    readMessages: async () => [assistant()],
    inspect: async () => observed(22),
  };
  new FileDeliveryService(options).preparePrompt(
    "ws_1",
    origin.sessionId,
    origin.runId,
    { messageID: origin.turnId },
  );
  const restored = new FileDeliveryService(options);
  expect(
    (await restored.synchronize("ws_1", origin.sessionId, false)).turns[0]
      ?.status,
  ).toBe("collecting");
  expect(
    (await restored.synchronize("ws_1", origin.sessionId, true)).turns[0],
  ).toMatchObject({ status: "ready" });
  expect(
    (await restored.synchronize("ws_1", origin.sessionId, true)).turns[0]
      ?.items,
  ).toHaveLength(1);
});

test("后台媒体任务晚于新轮次并跨服务重启完成时仍归原轮次", async () => {
  const path = await root();
  let complete = false;
  const options = {
    workspace: () => ({ id: "ws_1", path }),
    readMessages: async () => [assistant()],
    inspect: async () => observed(50),
    readMediaJob: () => ({
      id: "job_1",
      status: complete ? "completed" : "running",
      ...(complete ? { artifact: { path: "movie.mp4" } } : {}),
    }),
  };
  const service = new FileDeliveryService(options);
  service.preparePrompt("ws_1", origin.sessionId, origin.runId, {
    messageID: origin.turnId,
  });
  await service.bindMediaSubmission(
    "ws_1",
    origin.sessionId,
    "msg_assistant_1",
    "request_1",
  );
  service.registry("ws_1").finishRun(origin.runId);
  service.preparePrompt("ws_1", origin.sessionId, "run_2", {
    messageID: "msg_user_2",
  });
  const restored = new FileDeliveryService(options);
  expect((await restored.list("ws_1", origin.sessionId)).turns[0]?.status).toBe(
    "finalizing",
  );
  complete = true;
  const result = await restored.list("ws_1", origin.sessionId);
  expect(result.turns[0]).toMatchObject({
    turnId: origin.turnId,
    status: "ready",
  });
  expect(result.turns[0]?.items).toHaveLength(1);
  expect(result.turns[1]).toMatchObject({
    turnId: "msg_user_2",
    status: "collecting",
    items: [],
  });
});

test("恢复完成的媒体任务可替换原轮次的失败交付", async () => {
  const path = await root();
  let complete = false;
  const service = new FileDeliveryService({
    workspace: () => ({ id: "ws_1", path }), readMessages: async () => [assistant()],
    inspect: async () => observed(50),
    readMediaJob: () => ({ id: "job_1", status: complete ? "completed" : "failed", ...(complete ? { artifact: { path: "movie.mp4" } } : { error: { message: "video_provider_unknown_status" } }) }),
  });
  service.preparePrompt("ws_1", origin.sessionId, origin.runId, { messageID: origin.turnId });
  await service.bindMediaSubmission("ws_1", origin.sessionId, "msg_assistant_1", "request_1");
  service.registry("ws_1").finishRun(origin.runId);
  expect((await service.list("ws_1", origin.sessionId)).turns[0]?.status).toBe("failed");
  complete = true;
  const restored = (await service.list("ws_1", origin.sessionId)).turns[0];
  expect(restored?.status).toBe("ready");
  expect(restored?.targets[0]?.error).toBeUndefined();
  expect(restored?.items).toHaveLength(1);
});

test("工具输出过滤保留中文和大小写，不扫描任意 Shell 输出", () => {
  expect(artifactPathsFromTool(writePart("报告 A.docx"))).toEqual([
    "报告 A.docx",
  ]);
  expect(
    artifactPathsFromTool({ ...writePart("报告 A.docx"), tool: "bash" }),
  ).toEqual([]);
  expect(artifactPathsFromTool(writePart(".opencode/manifest.json"))).toEqual(
    [],
  );
});

for (const source of [
  "local-queue",
  "local-steer",
  "remote-pending",
] as const) {
  test(`${source} admission 重启重试保持真实归属，执行完成前不确认交付`, async () => {
    const path = await root();
    const identity = {
      workspaceId: "ws_1",
      sessionId: origin.sessionId,
      source,
      id: "queued-request",
    };
    let messages: ArtifactEngineMessage[] = [];
    const saved: string[] = [];
    const options = {
      workspace: () => ({ id: "ws_1", path }),
      readMessages: async () => messages,
      inspect: async (_workspace: string, name: string) => ({
        ...observed(29),
        value: name,
        name,
      }),
      saveTarget: async (
        _workspace: string,
        _origin: unknown,
        target: { documentId?: string },
      ) => {
        saved.push(target.documentId!);
      },
    };
    const service = new FileDeliveryService(options);
    const admitted = service.prepareAdmission(identity);
    expect(admitted.turnId).toBe(opencodeAdmissionId(identity));
    expect(service.prepareAdmission(identity)).toEqual(admitted);
    const restored = new FileDeliveryService(options);
    expect(restored.prepareAdmission(identity)).toEqual(admitted);
    expect(
      (await restored.synchronize("ws_1", origin.sessionId, true)).turns[0],
    ).toMatchObject({ status: "collecting", items: [], finishedRunIds: [] });
    messages = [assistant(admitted.turnId), assistant("msg_other")];
    await restored.bindOfficeModification(
      "ws_1",
      origin.sessionId,
      "msg_assistant_1",
      "office_1",
      "od_queue",
      "报告 B.docx",
    );
    expect(
      (await restored.synchronize("ws_1", origin.sessionId, true)).turns[0]
        ?.status,
    ).toBe("collecting");
    messages[0]!.info.time = { completed: 100 };
    messages[0]!.parts.push(writePart("未完成.docx", "running"));
    expect(
      (await restored.synchronize("ws_1", origin.sessionId, true)).turns[0]
        ?.status,
    ).toBe("collecting");
    messages[0]!.parts.pop();
    expect(
      (await restored.synchronize("ws_1", origin.sessionId, false)).turns[0]
        ?.status,
    ).toBe("collecting");
    expect(saved).toEqual([]);
    const finished = await restored.synchronize("ws_1", origin.sessionId, true);
    expect(finished.turns).toHaveLength(1);
    expect(finished.turns[0]).toMatchObject({
      turnId: admitted.turnId,
      status: "ready",
      finishedRunIds: [admitted.runId],
    });
    expect(finished.turns[0]!.items).toHaveLength(2);
    expect(saved).toEqual(["od_queue"]);
    expect(
      (await restored.synchronize("ws_1", origin.sessionId, true)).turns[0]
        ?.items,
    ).toEqual(finished.turns[0]!.items);
    expect(saved).toEqual(["od_queue"]);
  });
}
