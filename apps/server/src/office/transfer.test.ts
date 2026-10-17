import { expect, test } from "bun:test";
import { waitForOfficeTransfer } from "../../../desktop/electron/office-transfer.mjs";

test("等待期间宿主关闭会中断检查，保留迁移未完成状态", async () => {
  const host = new AbortController();
  let checked = 0;
  const ready = await waitForOfficeTransfer({
    documentId: "od_A",
    signal: host.signal,
    readStatus: async () => {
      checked++;
      return { documentId: "od_A", reason: "saving" };
    },
    showWait: async (signal) => {
      host.abort();
      expect(signal.aborted).toBe(true);
    },
  });
  expect(ready).toBe(false);
  expect(checked).toBe(1);
});

test("取消等待后即使旧检查晚到空闲结果，也不允许迁移", async () => {
  const host = new AbortController();
  const cancel = Promise.withResolvers<void>();
  let checked = 0;
  const ready = await waitForOfficeTransfer({
    documentId: "od_A",
    signal: host.signal,
    readStatus: async () => {
      checked++;
      if (checked === 1) return { documentId: "od_A", reason: "running" };
      cancel.resolve();
      await Promise.resolve();
      return { documentId: "od_A", reason: null };
    },
    showWait: async () => cancel.promise,
  });
  expect(ready).toBe(false);
  expect(checked).toBe(2);
});

test("不支持或身份错误的状态不能被当作空闲，也不弹出无限等待提示", async () => {
  for (const response of [
    { document: {} },
    { documentId: "od_other", reason: null },
    { documentId: "od_A", reason: "unknown" },
  ]) {
    await expect(
      waitForOfficeTransfer({
        documentId: "od_A",
        signal: new AbortController().signal,
        readStatus: async () => response,
        showWait: async () => {
          throw new Error("不应显示等待提示");
        },
      }),
    ).rejects.toThrow("迁移状态不可用");
  }
});
