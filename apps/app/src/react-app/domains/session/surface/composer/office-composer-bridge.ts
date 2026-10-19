import { useComposerStateStore, getComposerOfficeGroups, releasableOfficeReferences } from "../composer-state-store";

/**
 * 在应用级处理原生选区，所属聊天不在前台时仍更新它自己的草稿。
 * @param options 路由只用于显式添加/发送后展示所属聊天，不能替代引用归属
 */
export function installOfficeComposerBridge(options: { navigate: (path: string) => void; scope: () => string }) {
  const office = window.__JUGGLEWORK_ELECTRON__?.office;
  const stopRequests = office?.onComposerRequest?.(async (input) => {
    const state = useComposerStateStore.getState();
    const epoch = state.officeEpochs[input.sessionId] ?? 0;
    if (input.action === "prepare") return { epoch };
    if (input.action === "append") {
      if (input.reference.workspaceId !== input.workspaceId || input.reference.ownerSessionId !== input.sessionId) throw new Error("选区所属聊天已变化");
      state.appendOfficeSelection({ ...input, mode: input.mode });
      options.navigate(`/workspace/${encodeURIComponent(input.workspaceId)}/session/${encodeURIComponent(input.sessionId)}`);
      return { ok: true };
    }
    if (input.action === "guard") {
      const references = getComposerOfficeGroups(state, input.sessionId).flatMap((group) => group.references).filter((ref) => ref.workspaceId === input.workspaceId);
      const affected = references.filter((ref) => input.closingDocumentId ? ref.documentId === input.closingDocumentId
        : input.targetDocumentId ? ref.documentId !== input.targetDocumentId : !input.path || ref.preview.path !== input.path);
      return { epoch, scope: options.scope(), referenceIds: [...new Set(affected.map((ref) => ref.referenceId))], needsConfirmation: affected.length > 0 };
    }
    if (input.action === "clear") {
      if (options.scope() !== input.scope) return { ok: false };
      const ok = state.clearOfficeReferences(input.sessionId, input.epoch, input.referenceIds);
      return { ok, releaseIds: ok ? releasableOfficeReferences(useComposerStateStore.getState(), input.sessionId, input.referenceIds) : [] };
    }
    throw new Error("不支持的文档草稿操作");
  });
  const stopClosed = office?.onClosed?.((input) => {
    const state = useComposerStateStore.getState();
    const ids = getComposerOfficeGroups(state, input.sessionId).flatMap((group) => group.references)
      .filter((ref) => ref.workspaceId === input.workspaceId && ref.documentId === input.documentId).map((ref) => ref.referenceId);
    // 即使还没有标签，关闭也使该聊天中尚未返回的采集失效。
    state.clearOfficeReferences(input.sessionId, state.officeEpochs[input.sessionId] ?? 0, ids);
  });
  const stopDocuments = office?.onDocumentChanged?.((document) => {
    const state = useComposerStateStore.getState();
    const ids = getComposerOfficeGroups(state, document.ownerSessionId).flatMap((group) => group.references)
      .filter((ref) => ref.workspaceId === document.workspaceId && ref.documentId === document.documentId &&
        (["error", "closed", "external"].includes(document.state) || ref.sourcePageId !== document.pageId)).map((ref) => ref.referenceId);
    if (ids.length) state.clearOfficeReferences(document.ownerSessionId, state.officeEpochs[document.ownerSessionId] ?? 0, ids);
  });
  return () => { stopRequests?.(); stopClosed?.(); stopDocuments?.(); };
}
