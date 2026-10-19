import { dialog } from "electron";

/**
 * 两种文件宿主共用文本草稿与保存入口；按工作区和实际相对路径识别同一文件。
 * @param {object} options 托管服务客户端、可信窗口列表及发送方解析
 */
export function createFileEditor({ client, getWindows, resolveWindow }) {
  const records = new Map();
  const key = (input) => JSON.stringify([input.workspaceId, input.path]);
  const record = (input) => {
    let item = records.get(key(input));
    if (!item) {
      item = {
        workspaceId: input.workspaceId,
        path: input.path,
        draft: null,
        saved: null,
        external: false,
      };
      records.set(key(input), item);
    }
    return item;
  };
  const publish = (item) => {
    for (const window of getWindows())
      if (!window.isDestroyed())
        window.webContents.send("jugglework:file-editor:changed", { ...item });
  };
  const save = async (input) => {
    const item = record(input);
    const draft = item.draft;
    if (!draft) return item;
    if (item.external) throw new Error("文件已在外部应用打开，请先重新载入");
    const result = await client.postJson(
      `/workspace/${encodeURIComponent(item.workspaceId)}/files/raw`,
      {
        path: item.path,
        dataBase64: Buffer.from(draft.content, "utf8").toString("base64"),
        baseUpdatedAt: draft.baseUpdatedAt,
      },
    );
    item.saved = {
      content: draft.content,
      updatedAt: result.updatedAt,
      size: Buffer.byteLength(draft.content, "utf8"),
    };
    // TIPS: 保存期间的新输入继续保留，只把它的磁盘基准更新到刚保存的版本。
    if (item.draft === draft) item.draft = null;
    else if (item.draft)
      item.draft = { ...item.draft, baseUpdatedAt: result.updatedAt };
    publish(item);
    return item;
  };
  const prepare = async (input, window, closing = false) => {
    const item = record(input);
    if (!item.draft) return true;
    const options = {
      type: /** @type {const} */ ("question"),
      title: closing ? "关闭文件" : "保存文件",
      message: `是否保存“${item.path.split("/").at(-1)}”的修改？`,
      buttons: closing
        ? ["保存并关闭", "放弃修改", "取消"]
        : ["保存后继续", "取消"],
      defaultId: 0,
      cancelId: closing ? 2 : 1,
      noLink: true,
    };
    const { response } = await (window
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options));
    if (response === options.cancelId) return false;
    if (closing && response === 1) {
      item.draft = null;
      publish(item);
      return true;
    }
    await save(input);
    // 新输入尚未保存时不能继续关闭或导出旧版本。
    if (item.draft) throw new Error("文件仍有未保存修改，请保存后重试");
    return true;
  };
  return {
    /** 查询两种文件视图共用的草稿与最近一次保存结果。 */
    state: (input) => record(input),
    /** 保存同一个文本草稿，错误或冲突时保留内容。 */
    save,
    /** 文件操作前保存，取消后不执行操作。 */
    prepare: (input, window) => prepare(input, window),
    /** 关闭前提供保存、放弃与取消。 */
    close: (input, window) => prepare(input, window, true),
    /** 应用退出前覆盖侧栏与文件浏览器全部文本草稿。 */
    async prepareQuit() {
      for (const item of records.values())
        if (!(await prepare(item, getWindows()[0], true))) return false;
      return true;
    },
    /** 注册共用编辑会话，文档内容仅在当前桌面的可信窗口间传递。 */
    registerIpc(ipcMain) {
      const host = (event) => {
        const window = resolveWindow(event.sender);
        if (!window) throw new Error("文件编辑窗口已关闭");
        return window;
      };
      ipcMain.handle("jugglework:file-editor:state", (event, input) => {
        host(event);
        return record(input);
      });
      ipcMain.handle("jugglework:file-editor:update", (event, input, draft) => {
        host(event);
        const item = record(input);
        if (item.external && draft) throw new Error("文件已由外部应用接管");
        item.draft = draft;
        publish(item);
        return item;
      });
      ipcMain.handle("jugglework:file-editor:save", (event, input) => {
        host(event);
        return save(input);
      });
      ipcMain.handle("jugglework:file-editor:prepare", (event, input) =>
        prepare(input, host(event)),
      );
      ipcMain.handle("jugglework:file-editor:close", (event, input) =>
        prepare(input, host(event), true),
      );
      ipcMain.handle(
        "jugglework:file-editor:external",
        (event, input, external) => {
          host(event);
          const item = record(input);
          item.external = external;
          item.saved = null;
          publish(item);
        },
      );
    },
  };
}
