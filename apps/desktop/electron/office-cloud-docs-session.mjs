/**
 * 顺序转发同一已授权实例的 Word 业务操作，再投影原生 Yjs 结果；不保存离线操作日志。
 * @param {{word: {snapshot:()=>Promise<any>,apply:(frames:any[],revision:number)=>Promise<any>,structure:(change:any,revision:number)=>Promise<any>},native:{call:(type:string,payload:any)=>Promise<any>},onState:(state:any)=>void}} options 已绑定当前账号／租户／模型的窄接口
 */
export function createOfficeCloudDocsSession({ word, native, onState }) {
  let status = "attaching",
    forwardedRevision = 0,
    running = false,
    wake = false,
    retryTimer,
    stopped = false,
    remoteStructure;
  const pending = [],
    waiters = [];
  const publish = (extra = {}) => {
    try {
      onState({ status, ...extra });
    } catch {}
  };
  const pause = (reason, unknown = false) => {
    if (stopped) return;
    status = unknown ? "unknown" : "paused";
    clearTimeout(retryTimer);
    pending.length = 0;
    publish({ reason });
    for (const resolve of waiters.splice(0)) resolve({ status });
  };
  const successful = (result) =>
    ["applied", "attached", "discarded"].includes(result?.status);
  const call = async (type, payload) => {
    if (stopped) throw new Error("session_disposed");
    let result;
    try {
      result = await native.call(type, payload);
    } catch (error) {
      throw Object.assign(new Error("native_response_unconfirmed"), {
        unknown: [
          "editor.original",
          "editor.apply",
          "editor.structure",
          "editor.bind",
          "editor.ack",
        ].includes(type),
        cause: error,
      });
    }
    if (stopped) throw new Error("session_disposed");
    if (
      !successful(result) &&
      !(
        type === "editor.project" &&
        ["prepared", "awaiting-word"].includes(result?.status)
      )
    )
      throw Object.assign(
        new Error(result?.reason || "native_operation_unconfirmed"),
        { unknown: result?.status === "unknown" },
      );
    return result;
  };
  const retry = () => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      wake = true;
      void drain();
    }, 100);
    retryTimer.unref?.();
  };
  async function drain() {
    if (running || stopped || status !== "active") return;
    running = true;
    try {
      do {
        wake = false;
        while (pending.length) {
          const item = pending.shift();
          if (item.source === "cloud") continue;
          if (item.revision !== forwardedRevision + 1)
            throw new Error("word_event_gap");
          await call(
            Array.isArray(item.frames) ? "editor.apply" : "editor.structure",
            Array.isArray(item.frames)
              ? { frames: item.frames }
              : { change: item },
          );
          forwardedRevision = item.revision;
        }
        const snapshot = await word.snapshot();
        if (stopped) return;
        if (snapshot.status !== "active")
          throw new Error("word_model_invalidated");
        // TIPS: 页面已发生输入但 IPC 事件尚未到达时，不能拿新代次配旧原生基线生成回写。
        if (snapshot.revision !== forwardedRevision) {
          retry();
          break;
        }
        if (remoteStructure) {
          const change = remoteStructure;
          remoteStructure = undefined;
          const applied = await word.structure(change, forwardedRevision);
          if (applied.status !== "applied")
            throw Object.assign(new Error("word_structure_unconfirmed"), {
              unknown: applied.status === "unknown",
            });
          await call("editor.bind", { wordBlocks: applied.blocks });
          forwardedRevision = applied.revision;
          wake = true;
          continue;
        }
        const project = await call("editor.project", {});
        if (project.status === "awaiting-word") {
          retry();
          break;
        }
        if (pending.length) {
          await call("editor.discard", { token: project.token });
          wake = true;
          continue;
        }
        const applied = await word.apply(project.frames, forwardedRevision);
        if (stopped) return;
        if (["stale", "busy"].includes(applied.status)) {
          await call("editor.discard", { token: project.token });
          retry();
          break;
        }
        if (applied.status !== "applied")
          throw Object.assign(new Error("word_write_unconfirmed"), {
            unknown: applied.status === "unknown",
          });
        // 先确认原生定位映射，再处理期间到达的后续人工事件，不能重放正文来弥补响应丢失。
        await call("editor.ack", { token: project.token });
        forwardedRevision = applied.revision;
        publish({ modelSynchronized: pending.length === 0 });
      } while ((wake || pending.length) && status === "active" && !stopped);
    } catch (error) {
      pause(error.message || "session_failed", error.unknown === true);
    } finally {
      running = false;
      if (status === "active" && pending.length) void drain();
      else if (status === "active" && !retryTimer)
        for (const resolve of waiters.splice(0))
          resolve({ status, modelSynchronized: true });
    }
  }
  return {
    /** 只从双方明确一致的对象值开始；不以首次载入替代共同版本核对。 */
    async attach(bindings, deriveBindings = false, recoveryCheckpoint) {
      if (status !== "attaching") return { status };
      try {
        const snapshot = await word.snapshot();
        if (snapshot.status !== "active") throw new Error("word_not_ready");
        forwardedRevision = snapshot.revision;
        const attached = await call(
          recoveryCheckpoint ? "editor.restore" : "editor.attach",
          {
            bindings,
            deriveBindings,
            wordBlocks: snapshot.blocks,
            ...(recoveryCheckpoint ?? {}),
          },
        );
        // TIPS: 老版 Docs 没有对象基线核验，不能在放宽文件字节比较后直接恢复写入。
        if (recoveryCheckpoint && attached.baselineValidated !== true)
          throw new Error("word_recovery_baseline_unconfirmed");
        if (stopped) return { status };
        while (pending[0]?.revision <= forwardedRevision) pending.shift();
        status = "active";
        publish();
        wake = true;
        void drain();
        return { status, bindings: attached.bindings };
      } catch (error) {
        pause(error.message);
        return { status, reason: error.message };
      }
    },
    /** 接收已经通过实际 Office sender 及模型代次校验的事件；队列只用于当前异步调用窗口。 */
    wordChanged(event) {
      if (
        stopped ||
        !["attaching", "active"].includes(status) ||
        event?.source === "cloud"
      )
        return;
      if (
        !Number.isSafeInteger(event?.revision) ||
        event.revision < 1 ||
        JSON.stringify(event).length > 512 * 1024 ||
        pending.length >= 256
      ) {
        pause("word_event_overflow");
        return;
      }
      pending.push(event);
      wake = true;
      void drain();
    },
    /** 原生编辑变化只唤醒一次投影，不把事件当作已落盘或创建额外消息。 */
    nativeChanged() {
      if (status !== "active") return;
      wake = true;
      void drain();
    },
    /** 云端拆并在相同 Word 代次和共同版本下回写；并发结构冲突时保留双方并暂停。 */
    nativeStructure(change) {
      if (status !== "active") return { status };
      if (remoteStructure) {
        pause("structure_conflict");
        return { status };
      }
      remoteStructure = change;
      wake = true;
      void drain();
      return { status: "queued" };
    },
    /** 等待当前业务窗口完成；不声明云服务器已经备份或 Word 文件已经保存。 */
    async flush() {
      if (status !== "active") return { status };
      wake = true;
      void drain();
      return new Promise((resolve) => waiters.push(resolve));
    },
    /** 释放当前实例；未确认操作不跨账号、页面或新实例自动重放。 */
    dispose() {
      stopped = true;
      status = "disposed";
      clearTimeout(retryTimer);
      pending.length = 0;
      for (const resolve of waiters.splice(0)) resolve({ status });
    },
    /** 查询当前状态。 */
    state() {
      return { status, pending: pending.length };
    },
  };
}
