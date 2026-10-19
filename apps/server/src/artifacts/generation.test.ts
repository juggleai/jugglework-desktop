import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FileDeliveryService } from "./delivery.js";
import { generateArtifactFiles } from "../opencode-plugins/artifact-generate.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "jugglework-generation-test-"));
  roots.push(root);
  const service = new FileDeliveryService({
    workspace: () => ({ id: "ws_1", path: root }),
    readMessages: async () => [
      {
        info: { id: "msg_assistant", role: "assistant", parentID: "msg_user" },
        parts: [],
      },
    ],
    inspect: async (_, path) => {
      const info = await stat(join(root, path)).catch(() => null);
      return info?.isFile()
        ? {
            value: path,
            name: basename(path),
            preview: "document",
            exists: true,
            size: info.size,
            updatedAt: info.mtimeMs,
          }
        : null;
    },
  });
  service.preparePrompt("ws_1", "ses_1", "run_1", { messageID: "msg_user" });
  const host = {
    prepare: (outputs: string[]) =>
      service.prepareGeneration("ws_1", "ses_1", "msg_assistant", outputs),
    complete: async (generationId: string, exitCode: number | null) => {
      const data = await service.completeGeneration(
        "ws_1",
        "ses_1",
        generationId,
        exitCode,
      );
      const targets = data.turns[0]!.targets.filter(
        (target) =>
          target.key === generationId ||
          target.key.startsWith(`${generationId}:`),
      );
      return {
        ok:
          data.files.length > 0 &&
          targets.every((target) => target.status === "ready"),
        files: data.files,
        targets,
      };
    },
  };
  return { root, service, host };
}

test("真实静默进程无需打印或追加注册，宿主自动收集中文文件并保存原始轮次", async () => {
  const { root, service, host } = await harness();
  const permissions: unknown[] = [];
  const result = (await generateArtifactFiles(
    {
      program: process.execPath,
      args: [
        "-e",
        'require("node:fs").writeFileSync("静默 报告.docx", "saved");',
      ],
    },
    {
      ask: async (request) => {
        permissions.push(request);
      },
    },
    host,
  )) as { ok: boolean; output: string; generationId: string };
  expect(result).toMatchObject({ ok: true, output: "" });
  expect(permissions).toMatchObject([{ permission: "bash", always: [] }]);
  expect(
    (await service.completeGeneration("ws_1", "ses_1", result.generationId, 0))
      .turns[0]?.items,
  ).toHaveLength(1);
  await service.finishRun("ws_1", "ses_1", "run_1");
  const data = await service.list("ws_1", "ses_1");
  expect(data.turns[0]).toMatchObject({
    turnId: "msg_user",
    runIds: ["run_1"],
    status: "ready",
  });
  expect(data.turns[0]?.items[0]?.snapshot).toMatchObject({
    name: "静默 报告.docx",
    sizeBytes: 5,
  });
  expect(await readFile(join(root, data.files[0]!.relativePath), "utf8")).toBe(
    "saved",
  );
});

test("声明生成目录内的相对输出不会重复登记为缺失文件", async () => {
  const { service, host } = await harness();
  const result = (await generateArtifactFiles(
    {
      program: process.execPath,
      args: ["-e", 'require("node:fs").writeFileSync("报告.docx", "saved");'],
      outputs: ["./报告.docx"],
    },
    { ask: async () => {} },
    host,
  )) as {
    ok: boolean;
    generationId: string;
    delivery: { files: unknown[]; targets: Array<{ path?: string; status: string }> };
  };

  expect(result.ok).toBe(true);
  expect(result.delivery.files).toHaveLength(1);
  expect(result.delivery.targets).toHaveLength(2);
  expect(result.delivery.targets.every((target) => target.status === "ready")).toBe(true);
  expect(result.delivery.targets.filter((target) => target.path === "./报告.docx")).toHaveLength(0);
  expect((await service.list("ws_1", "ses_1")).turns[0]?.items).toHaveLength(1);
});

test("生成目录之外的声明输出仍作为独立路径校验", async () => {
  const { host } = await harness();
  const result = (await generateArtifactFiles(
    {
      program: process.execPath,
      args: ["-e", 'require("node:fs").writeFileSync("报告.docx", "saved");'],
      outputs: ["artifacts/final/报告.docx"],
    },
    { ask: async () => {} },
    host,
  )) as {
    ok: boolean;
    delivery: { files: unknown[]; targets: Array<{ path?: string; status: string }> };
  };

  expect(result.ok).toBe(false);
  expect(result.delivery.files).toHaveLength(1);
  expect(result.delivery.targets).toContainEqual(expect.objectContaining({
    path: "artifacts/final/报告.docx",
    status: "failed",
  }));
});

test("拒绝权限或缺少权限上下文时，不分配目录、不执行程序", async () => {
  let allocated = false;
  const host = {
    prepare: async () => {
      allocated = true;
      throw new Error("must not run");
    },
    complete: async () => ({ ok: false, files: [] }),
  };
  const input = {
    program: process.execPath,
    args: ["-e", 'throw new Error("should not execute")'],
  };
  await expect(
    generateArtifactFiles(
      input,
      {
        ask: async () => {
          throw new Error("denied");
        },
      },
      host,
    ),
  ).rejects.toThrow("denied");
  await expect(
    generateArtifactFiles(
      input,
      {} as Parameters<typeof generateArtifactFiles>[1],
      host,
    ),
  ).rejects.toThrow("权限上下文");
  expect(allocated).toBe(false);
});

test("失败进程的残留和重启前未确认退出的结果均不发布，不自动重跑", async () => {
  const { service, host } = await harness();
  const result = (await generateArtifactFiles(
    {
      program: process.execPath,
      args: [
        "-e",
        'require("node:fs").writeFileSync("残留.docx", "partial");process.exit(1);',
      ],
    },
    { ask: async () => {} },
    host,
  )) as { ok: boolean; generationId: string };
  expect(result.ok).toBe(false);
  await service.finishRun("ws_1", "ses_1", "run_1");
  const data = await service.retry("ws_1", "ses_1", "msg_user");
  expect(data.files).toHaveLength(0);
  expect(data.turns[0]).toMatchObject({ status: "failed", items: [] });
  expect(data.turns[0]?.targets[0]).toMatchObject({
    status: "failed",
    retryable: false,
  });
  const other = await harness();
  await other.service.prepareGeneration("ws_1", "ses_1", "msg_assistant", []);
  expect(
    (await other.service.synchronize("ws_1", "ses_1", true)).turns[0],
  ).toMatchObject({ status: "failed", items: [] });
});

test("零输出不能伪报成功，完成回调重放不发布失败残留", async () => {
  const { service, host } = await harness();
  const result = (await generateArtifactFiles(
    { program: process.execPath, args: ["-e", ""] },
    { ask: async () => {} },
    host,
  )) as { ok: boolean; generationId: string };
  expect(result.ok).toBe(false);
  expect(
    (await service.completeGeneration("ws_1", "ses_1", result.generationId, 0))
      .files,
  ).toHaveLength(0);
});
