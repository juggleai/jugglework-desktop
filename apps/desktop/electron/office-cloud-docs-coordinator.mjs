import { createOfficeCloudDocsSession } from "./office-cloud-docs-session.mjs";

/**
 * 将存活 Office Word 页面、后台 AFFiNE 编辑器和双向控制器绑定成单一关联会话。
 * @param {{officePanel:any,editors:any,bindingsStore?:any,onState:(attachmentId:string,state:any)=>void}} options 生产宿主依赖
 */
export function createOfficeCloudDocsCoordinator({
  officePanel,
  editors,
  bindingsStore,
  onState,
}) {
  const sessions = new Map();
  const documents = new Map();
  const publish = (attachmentId, state) => {
    try {
      const documentId = sessions.get(attachmentId)?.documentId;
      onState(attachmentId, { ...(documentId ? { documentId } : {}), ...state });
    } catch {}
  };
  const validBindings = (bindings) =>
    Array.isArray(bindings) &&
    bindings.length > 0 &&
    bindings.length <= 128 &&
    new Set(bindings.map((item) => item?.paragraphId)).size ===
      bindings.length &&
    new Set(bindings.map((item) => item?.blockId)).size === bindings.length &&
    bindings.every(
      (item) =>
        /^[a-f0-9]{8}$/i.test(item?.paragraphId ?? "") &&
        typeof item?.blockId === "string" &&
        item.blockId.length > 0 &&
        item.blockId.length <= 64,
    );
  /** 释放当前关联；只操作该关联创建的页面桥和后台编辑器。 */
  async function unlink(attachmentId, reason = "user_unlinked") {
    const entry = sessions.get(attachmentId);
    if (!entry) return { status: "detached" };
    sessions.delete(attachmentId);
    if (documents.get(entry.documentId) === attachmentId)
      documents.delete(entry.documentId);
    // TIPS: 任一宿主关闭失败都不能阻止其余资源释放；本地状态写入失败仍返回给显式调用者。
    try {
      entry.controller?.dispose();
    } catch {}
    try {
      entry.native?.close();
    } catch {}
    try {
      await entry.office?.close();
    } catch {}
    let stateError;
    try {
      await bindingsStore?.setState(
        attachmentId,
        reason === "user_unlinked" || reason === "replaced"
          ? "unlinked"
          : "paused",
        reason,
      );
    } catch (error) {
      stateError = error;
    }
    publish(attachmentId, { status: "detached", reason });
    if (stateError) throw stateError;
    return { status: "detached" };
  }
  /**
   * 建立一份 Word 与一个已创建 AFFiNE 页面之间的正式关联。
   * @param {any} input 含一次性交接、文件身份和稳定对象映射的关联请求
   */
  async function link(input) {
    if (
      !/^[a-f0-9-]{36}$/i.test(input?.attachmentId ?? "") ||
      typeof input?.documentId !== "string" ||
      !input.documentId ||
      !(
        validBindings(input.bindings) ||
        (input?.deriveBindings === true &&
          Array.isArray(input.bindings) &&
          input.bindings.length === 0)
      )
    )
      throw new Error("invalid_word_cloud_binding");
    await unlink(input.attachmentId, "replaced");
    const priorAttachment = documents.get(input.documentId);
    if (priorAttachment) await unlink(priorAttachment, "replaced");
    const entry = {
      attachmentId: input.attachmentId,
      documentId: input.documentId,
      pageId: input.pageId,
      controller: null,
      native: null,
      office: null,
      queuedWord: [],
      queuedNative: [],
      preparedCheckpoint: null,
      checkpointId: input.checkpoint?.checkpointId ?? null,
      sourceServerOrigin: input.sourceServerOrigin,
      sourceUserId: input.sourceUserId,
      tenantId: input.tenantId,
    };
    sessions.set(input.attachmentId, entry);
    documents.set(input.documentId, input.attachmentId);
    publish(input.attachmentId, { status: "attaching" });
    try {
      entry.office = await officePanel.attachWordCloud(
        input.documentId,
        (message) => {
          if (sessions.get(input.attachmentId) !== entry) return;
          if (!entry.controller) {
            entry.queuedWord.push(message);
            return;
          }
          if (message.type === "word.paused") {
            void unlink(
              input.attachmentId,
              message.payload?.reason || "word_paused",
            ).catch(() => undefined);
          } else entry.controller.wordChanged(message.payload);
        },
      );
      entry.native = await editors.open(input);
      if (
        input.expectedWorkspaceId &&
        entry.native.context.workspaceId !== input.expectedWorkspaceId
      )
        throw new Error("word_recovery_workspace_mismatch");
      if (sessions.get(input.attachmentId) !== entry)
        throw new Error("word_cloud_binding_replaced");
      if (input.original) {
        const original = await entry.native.call("editor.original", input.original);
        if (original?.status !== "applied")
          throw new Error(original?.reason || "word_original_unconfirmed");
      }
      entry.controller = createOfficeCloudDocsSession({
        word: entry.office.word,
        native: entry.native,
        onState: (state) => publish(input.attachmentId, state),
      });
      for (const message of entry.queuedWord.splice(0)) {
        if (message.type === "word.paused")
          throw new Error(message.payload?.reason || "word_paused");
        entry.controller.wordChanged(message.payload);
      }
      for (const message of entry.queuedNative.splice(0))
        handleNativeEvent(input.attachmentId, message);
      const result = await entry.controller.attach(
        input.bindings,
        input.deriveBindings === true,
        input.recoveryCheckpoint,
      );
      if (result.status !== "active") throw new Error(result.reason || "word_attach_failed");
      const confirmedBindings = result.bindings ?? input.bindings;
      if (!validBindings(confirmedBindings))
        throw new Error("word_binding_mapping_unconfirmed");
      await bindingsStore?.upsert({
        attachmentId: input.attachmentId,
        documentId: input.documentId,
        sourceServerOrigin: input.sourceServerOrigin,
        sourceUserId: input.sourceUserId,
        tenantId: input.tenantId,
        docsWorkspaceId: entry.native.context.workspaceId,
        pageId: input.pageId,
        localWorkspaceId: input.localWorkspaceId,
        relativePath: input.relativePath,
        bindings: confirmedBindings,
        state: "active",
        checkpoint: input.checkpoint ?? null,
      });
      publish(input.attachmentId, {
        status: "active",
        documentId: input.documentId,
        pageId: input.pageId,
      });
      return { status: "active", attachmentId: input.attachmentId };
    } catch (error) {
      await unlink(
        input.attachmentId,
        error instanceof Error ? error.message : "word_cloud_link_failed",
      ).catch(() => undefined);
      throw error;
    }
  }
  /** 接收后台 AFFiNE 编辑器的固定事件并路由到当前关联。 */
  function handleNativeEvent(attachmentId, message) {
    const entry = sessions.get(attachmentId);
    if (!entry) return;
    if (!entry.controller) {
      entry.queuedNative.push(message);
      return;
    }
    if (message.type === "editor.pending") entry.controller.nativeChanged();
    else if (message.type === "editor.structure")
      entry.controller.nativeStructure(message.payload);
    else if (message.type === "editor.paused")
      void unlink(
        attachmentId,
        message.payload?.reason || "native_editor_paused",
      ).catch(() => undefined);
  }
  return {
    link,
    /**
     * 使用持久共同检查点恢复新 Office 模型；原生恢复端核对实际对象，不因 DOCX 重新打包而误判。
     * @param {any} input 当前账号交接、精确本地文件和 Server 已核对的 Office 会话
     */
    async recover(input) {
      const loaded = await bindingsStore?.loadRecovery(input);
      if (!loaded) throw new Error("word_recovery_not_found");
      const { binding, recoveryCheckpoint } = loaded;
      const document = input.document;
      if (
        document?.workspaceId !== binding.localWorkspaceId ||
        document?.relativePath !== binding.relativePath ||
        document?.state !== "ready" ||
        !document.engineFileId ||
        !/^[a-f0-9]{64}$/.test(document.savedFileSha256 ?? "")
      ) {
        await bindingsStore.setState(
          binding.attachmentId,
          "paused",
          "word_recovery_file_unavailable",
        );
        return { status: "paused", reason: "word_recovery_file_unavailable" };
      }
      const result = await link({
        ...input,
        attachmentId: binding.attachmentId,
        documentId: document.documentId,
        localWorkspaceId: binding.localWorkspaceId,
        relativePath: binding.relativePath,
        pageId: binding.pageId,
        bindings: binding.bindings,
        checkpoint: binding.checkpoint,
        expectedWorkspaceId: binding.docsWorkspaceId,
        recoveryCheckpoint,
      });
      return {
        ...result,
        recoveryCheckpointId: binding.checkpoint.checkpointId,
      };
    },
    unlink,
    /** Office 模型关闭后立即释放该文件拥有的后台编辑器并保留共同检查点。 */
    async unlinkDocument(documentId, reason = "word_closed") {
      const attachmentId = documents.get(documentId);
      return attachmentId
        ? unlink(attachmentId, reason)
        : { status: "detached" };
    },
    /** 源会话或组织权限失效时释放该组织全部 Word 关联，不影响同账号其他组织。 */
    async unlinkScope(scope, reason = "session_expired") {
      const targets = [...sessions.values()]
        .filter(
          entry =>
            entry.sourceServerOrigin === scope?.sourceServerOrigin &&
            entry.sourceUserId === scope?.sourceUserId &&
            entry.tenantId === scope?.tenantId,
        )
        .map(entry => entry.attachmentId);
      let firstError;
      for (const attachmentId of targets) {
        try {
          await unlink(attachmentId, reason);
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) throw firstError;
      return { status: "detached", count: targets.length };
    },
    handleNativeEvent,
    /** 等待当前对象操作窗口完成，不替代 Word 文件保存或 AFFiNE 服务端持久化回执。 */
    async flush(attachmentId) {
      return sessions.get(attachmentId)?.controller?.flush() ?? {
        status: "detached",
      };
    },
    /** 在 Office 保存前等待该文件当前关联的对象操作完成。 */
    async flushDocument(documentId) {
      const attachmentId = documents.get(documentId);
      return attachmentId
        ? sessions.get(attachmentId)?.controller?.flush() ?? {
            status: "detached",
          }
        : { status: "detached" };
    },
    /**
     * Office 落盘前捕获 Word 代次、原生 Y.Doc 和稳定对象映射；此时只准备资源，不推进共同检查点。
     * @param {{documentId:string,pageId:string}} document 当前 Server 已核对的 Office 模型
     */
    async prepareCheckpoint(document) {
      const attachmentId = documents.get(document?.documentId);
      if (!attachmentId) return { status: "detached" };
      const entry = sessions.get(attachmentId);
      if (!entry?.controller || !entry.native || !entry.office)
        return { status: "detached" };
      entry.preparedCheckpoint = null;
      const synchronized = await entry.controller.flush();
      if (
        synchronized?.status !== "active" ||
        synchronized.modelSynchronized !== true
      )
        return synchronized;
      const before = await entry.office.word.snapshot();
      if (before?.status !== "active") return { status: "paused" };
      const checkpoint = await entry.native.call("editor.checkpoint", {});
      const after = await entry.office.word.snapshot();
      if (
        checkpoint?.status !== "prepared" ||
        typeof checkpoint.nativeStateVector !== "string" ||
        typeof checkpoint.nativeSnapshot !== "string" ||
        checkpoint.mappingCheckpoint?.schemaVersion !== 1 ||
        !validBindings(checkpoint.bindings) ||
        before?.revision !== after?.revision ||
        after?.status !== "active" ||
        entry.controller.state().pending !== 0
      )
        return { status: "paused", reason: "checkpoint_changed" };
      entry.preparedCheckpoint = {
        pageId: document.pageId,
        wordRevision: after.revision,
        nativeSchemaVersion: checkpoint.nativeSchemaVersion,
        nativeStateVector: checkpoint.nativeStateVector,
        nativeSnapshot: checkpoint.nativeSnapshot,
        mappingCheckpoint: checkpoint.mappingCheckpoint,
        bindings: checkpoint.bindings,
      };
      return { status: "active", modelSynchronized: true };
    },
    /**
     * Office 真实文件保存成功后复核双方未变化，再原子推进不可变共同检查点。
     * @param {{documentId:string,pageId:string,savedAt:number|null,savedFileSha256?:string|null}} document Server 保存回执
     */
    async confirmSaved(document) {
      const attachmentId = documents.get(document?.documentId);
      if (!attachmentId) return { status: "detached" };
      const entry = sessions.get(attachmentId);
      const prepared = entry?.preparedCheckpoint;
      if (!entry || !prepared) return { status: "skipped" };
      entry.preparedCheckpoint = null;
      if (
        prepared.pageId !== document.pageId ||
        !Number.isSafeInteger(document.savedAt) ||
        !/^[a-f0-9]{64}$/.test(document.savedFileSha256 ?? "")
      )
        return { status: "skipped" };
      const word = await entry.office.word.snapshot();
      const native = await entry.native.call("editor.checkpoint", {});
      if (
        word?.status !== "active" ||
        word.revision !== prepared.wordRevision ||
        native?.status !== "prepared" ||
        native.nativeStateVector !== prepared.nativeStateVector ||
        JSON.stringify(native.mappingCheckpoint) !==
          JSON.stringify(prepared.mappingCheckpoint) ||
        JSON.stringify(native.bindings) !== JSON.stringify(prepared.bindings) ||
        entry.controller.state().pending !== 0
      )
        return { status: "skipped", reason: "checkpoint_changed" };
      const checkpoint = await bindingsStore?.commitCheckpoint({
        attachmentId,
        localSavedFileSha256: document.savedFileSha256,
        nativeStateVector: prepared.nativeStateVector,
        nativeSnapshot: prepared.nativeSnapshot,
        mappingCheckpoint: prepared.mappingCheckpoint,
        nativeSchemaVersion: prepared.nativeSchemaVersion,
        bindings: prepared.bindings,
        confirmedAt: document.savedAt,
      });
      if (!checkpoint) return { status: "skipped" };
      entry.checkpointId = checkpoint.checkpointId;
      publish(attachmentId, { status: "active", checkpoint });
      return { status: "confirmed", checkpoint };
    },
    /** 查询当前关联状态。 */
    state(attachmentId) {
      const entry = sessions.get(attachmentId);
      return entry
        ? {
            ...entry.controller?.state(),
            attachmentId,
            documentId: entry.documentId,
            checkpointId: entry.checkpointId,
          }
        : { status: "detached" };
    },
    /** 按当前存活 Word 模型读取真实关联；不按文件名或其他账号的持久记录猜测。 */
    documentState(documentId) {
      const entry = sessions.get(documents.get(documentId));
      return entry ? {
        status: entry.controller?.state().status ?? "attaching",
        tenantId: entry.tenantId, pageId: entry.pageId,
        workspaceId: entry.native?.context?.workspaceId,
      } : { status: "detached" };
    },
    /** 退出时释放全部后台编辑器和 Word 页面钩子。 */
    async dispose() {
      let firstError;
      for (const id of [...sessions.keys()]) {
        try {
          await unlink(id, "disposed");
        } catch (error) {
          firstError ??= error;
        }
      }
      editors.dispose();
      if (firstError) throw firstError;
    },
  };
}
