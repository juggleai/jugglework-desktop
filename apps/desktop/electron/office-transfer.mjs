import { setTimeout } from "node:timers/promises";

/**
 * 等待运行、保存及交付结束；取消对话框或宿主关闭只取消等待，不改变文档归属。
 * @param {{ documentId: string, readStatus: (signal?: AbortSignal) => Promise<any>, showWait: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal }} options 状态查询、可取消提示及宿主生命周期
 * @returns {Promise<boolean>} 当前可继续迁移，或已取消等待
 */
export async function waitForOfficeTransfer({
  documentId,
  readStatus,
  showWait,
  signal,
}) {
  const controller = new AbortController();
  const waitingSignal = AbortSignal.any([signal, controller.signal]);
  const read = async () => {
    const status = await readStatus(waitingSignal);
    if (
      status?.documentId !== documentId ||
      ![null, "running", "finalizing", "saving"].includes(status.reason)
    )
      throw new Error("文档迁移状态不可用，请重启桌面应用后重试");
    return status;
  };
  let dialog;
  let dialogError;
  try {
    let status = await read();
    if (status.reason === null) return !waitingSignal.aborted;
    dialog = showWait(waitingSignal).then(
      () => controller.abort(),
      (error) => {
        dialogError = error;
        controller.abort();
      },
    );
    while (status.reason !== null) {
      await setTimeout(1000, undefined, { signal: waitingSignal });
      status = await read();
    }
    return !waitingSignal.aborted;
  } catch (error) {
    if (waitingSignal.aborted) return false;
    throw error;
  } finally {
    controller.abort();
    await dialog;
    if (dialogError) throw dialogError;
  }
}
