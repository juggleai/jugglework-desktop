import { afterEach, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let answer = 2;
mock.module("electron", () => ({
  dialog: { showMessageBox: async () => ({ response: answer }) },
}));
const { createFileEditor } =
  await import("../../../desktop/electron/file-editor.mjs");
const roots: string[] = [];
afterEach(async () => {
  answer = 2;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "shared-file-"));
  roots.push(root);
  const file = join(root, "客户.csv");
  await writeFile(file, "姓名,营收\n张伟,10\n");
  const target = { workspaceId: "ws", path: "客户.csv" };
  const received = [[], []] as any[][];
  const windows = received.map((messages, index) => ({
    id: index + 1,
    isDestroyed: () => false,
    webContents: {
      id: index + 1,
      send: (name: string, value: any) =>
        messages.push({ name, value: structuredClone(value) }),
    },
  }));
  let failure = false;
  let gate: Promise<void> | undefined;
  let time = 1;
  const editor = createFileEditor({
    getWindows: () => windows,
    resolveWindow: (sender: any) =>
      windows.find((window) => window.webContents.id === sender.id),
    client: {
      async postJson(_path: string, body: any) {
        if (failure) throw new Error("保存失败");
        await gate;
        await writeFile(file, Buffer.from(body.dataBase64, "base64"));
        return { updatedAt: ++time };
      },
    },
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  editor.registerIpc({
    handle: (name: string, callback: any) => handlers.set(name, callback),
  } as any);
  const call = (name: string, host: number, ...args: any[]) =>
    handlers.get(`jugglework:file-editor:${name}`)!(
      { sender: windows[host]!.webContents },
      target,
      ...args,
    );
  return {
    editor,
    call,
    received,
    target,
    file,
    setFailure: (value: boolean) => {
      failure = value;
    },
    setGate: (value: Promise<void>) => {
      gate = value;
    },
  };
}

test("文件浏览器与右侧栏共享同一 CSV 草稿，任一端保存后另一端获得实际落盘版本", async () => {
  const f = await fixture();
  const draft = { content: "姓名,营收\n张伟,20\n", baseUpdatedAt: 1 };
  await f.call("update", 0, draft);
  expect((await f.call("state", 1)).draft).toEqual(draft);
  expect(f.received[1].at(-1)?.value.draft).toEqual(draft);
  await f.call("save", 1);
  expect(await readFile(f.file, "utf8")).toBe(draft.content);
  expect((await f.call("state", 0)).draft).toBeNull();
  expect(f.received[0].at(-1)?.value.saved.content).toBe(draft.content);
});

test("取消关闭、保存失败和退出取消均保留未保存内容，放弃后才清空", async () => {
  const f = await fixture();
  const draft = { content: "未保存的客户数据", baseUpdatedAt: 1 };
  await f.call("update", 1, draft);
  answer = 2;
  expect(await f.call("close", 1)).toBe(false);
  expect(await f.editor.prepareQuit()).toBe(false);
  answer = 0;
  f.setFailure(true);
  await expect(f.call("close", 0)).rejects.toThrow("保存失败");
  expect((await f.call("state", 0)).draft).toEqual(draft);
  expect(await readFile(f.file, "utf8")).toContain("张伟,10");
  answer = 1;
  expect(await f.call("close", 1)).toBe(true);
  expect((await f.call("state", 0)).draft).toBeNull();
});

test("保存期间的新输入继续保持 dirty，下一次保存沿用更新后的磁盘基准", async () => {
  const f = await fixture();
  let resume!: () => void;
  f.setGate(
    new Promise<void>((resolve) => {
      resume = resolve;
    }),
  );
  await f.call("update", 0, { content: "旧内容", baseUpdatedAt: 1 });
  const saving = f.call("save", 0);
  await f.call("update", 1, { content: "继续输入的新内容", baseUpdatedAt: 1 });
  resume();
  await saving;
  expect(await readFile(f.file, "utf8")).toBe("旧内容");
  expect((await f.call("state", 0)).draft).toEqual({
    content: "继续输入的新内容",
    baseUpdatedAt: 2,
  });
  await f.call("save", 1);
  expect(await readFile(f.file, "utf8")).toBe("继续输入的新内容");
  expect((await f.call("state", 1)).draft).toBeNull();
});
