import { randomUUID } from "node:crypto";

import {
  createOfficeWordBlocksAdapter,
  readOfficeWordBlocks,
} from "./office-word-blocks-adapter.mjs";

/**
 * 在真实 Office Word 页面主世界安装受限对象桥。
 * @param {any} scope Office 页面全局对象
 * @param {string} bridgeId 当前页面代次
 * @param {(scope: any) => any[]} read 真实 SDK 模型读取器
 * @param {(options: any, scope: any, read: any) => any} create 真实 SDK 适配器构造器
 * @returns {any} 当前 Word 对象快照
 */
export function installOfficeWordCloudBridge(
  scope,
  bridgeId,
  read,
  create,
) {
  // TIPS: 此函数通过 toString 注入 Office 主世界，不能依赖模块闭包变量。
  const bridgeKey = "__juggleworkOfficeWordCloudBridge";
  const previous = scope[bridgeKey];
  previous?.adapter?.dispose?.();
  const emit = (type, payload) =>
    scope.postMessage(
      {
        channel: "jugglework-office-word-cloud",
        message: { bridgeId, type, payload },
      },
      scope.location.origin,
    );
  const blocks = read(scope);
  const adapter = create(
    {
      blocks,
      onChange: (change) => emit("word.changed", change),
      onStructure: (change) => emit("word.structure", change),
      onPause: (reason) => emit("word.paused", { reason }),
    },
    scope,
    read,
  );
  scope[bridgeKey] = { bridgeId, adapter };
  return adapter.snapshot();
}

/**
 * 调用当前 Office Word 页面桥的固定操作。
 * @param {any} scope Office 页面全局对象
 * @param {string} bridgeId 当前页面代次
 * @param {'snapshot'|'apply'|'structure'|'dispose'} operation 固定业务操作
 * @param {any} payload 受限操作参数
 * @returns {any} SDK 适配结果
 */
export function callOfficeWordCloudBridge(
  scope,
  bridgeId,
  operation,
  payload,
) {
  const bridgeKey = "__juggleworkOfficeWordCloudBridge";
  const current = scope[bridgeKey];
  if (!current || current.bridgeId !== bridgeId)
    throw new Error("word_bridge_generation_changed");
  if (operation === "snapshot") return current.adapter.snapshot();
  if (operation === "apply")
    return current.adapter.applyRemoteAtRevision(
      payload?.frames,
      payload?.revision,
    );
  if (operation === "structure")
    return current.adapter.applyRemoteStructureAtRevision(
      payload?.change,
      payload?.revision,
    );
  if (operation === "dispose") {
    current.adapter.dispose();
    delete scope[bridgeKey];
    return { status: "disposed" };
  }
  throw new Error("unsupported_word_bridge_operation");
}

/**
 * 为一个存活 Office Word WebContents 创建窄双向接口。
 * @param {{webContents: Electron.WebContents,onEvent:(event:any)=>void,isCurrent:()=>boolean}} options 页面、事件接收器与代次校验
 * @returns {Promise<{bridgeId:string,word:{snapshot:()=>Promise<any>,apply:(frames:any[],revision:number)=>Promise<any>,structure:(change:any,revision:number)=>Promise<any>},accept:(message:any)=>boolean,dispose:()=>Promise<void>}>} 当前页面桥
 */
export async function createOfficeWordCloudBridge({
  webContents,
  onEvent,
  isCurrent,
}) {
  const bridgeId = randomUUID();
  const install = `(${installOfficeWordCloudBridge.toString()})(window,${JSON.stringify(bridgeId)},${readOfficeWordBlocks.toString()},${createOfficeWordBlocksAdapter.toString()})`;
  await webContents.executeJavaScript(install);
  const call = async (operation, payload = {}) => {
    if (!isCurrent() || webContents.isDestroyed())
      throw new Error("word_bridge_generation_changed");
    const body = JSON.stringify(payload);
    if (body.length > 1024 * 1024)
      throw new Error("word_bridge_message_too_large");
    return webContents.executeJavaScript(
      `(${callOfficeWordCloudBridge.toString()})(window,${JSON.stringify(bridgeId)},${JSON.stringify(operation)},${body})`,
    );
  };
  return {
    bridgeId,
    word: {
      /** 读取当前已核实 Word 对象和代次。 */
      snapshot: () => call("snapshot"),
      /** 在指定 Word 代次应用云端文本投影。 */
      apply: (frames, revision) => call("apply", { frames, revision }),
      /** 在指定 Word 代次应用云端单次段落拆并。 */
      structure: (change, revision) =>
        call("structure", { change, revision }),
    },
    /** 只接收当前页面和当前桥代次的固定 Word 事件。 */
    accept(message) {
      if (
        !isCurrent() ||
        message?.bridgeId !== bridgeId ||
        !["word.changed", "word.structure", "word.paused"].includes(
          message.type,
        )
      )
        return false;
      onEvent(message);
      return true;
    },
    /** 释放当前页面桥；页面已经销毁时只结束宿主关联。 */
    async dispose() {
      if (!webContents.isDestroyed() && isCurrent())
        await call("dispose").catch(() => {});
    },
  };
}
