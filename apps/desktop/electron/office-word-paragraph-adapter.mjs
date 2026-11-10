/**
 * 建立 SDK 0.0.0.499 的单普通段落实验适配；不自动注册到产品或建立文件关联。
 * @param {{paragraphId: string, start: number, text: string, onChange: (change: any) => void, onPause: (reason: string) => void}} options 已由当前模型核实的段落及同步回调
 * @param {any} scope 配套 Word 编辑页全局对象
 * @returns {{applyRemote: (edits: any[]) => {status: string}, dispose: () => void, state: () => string}} 定点回写及生命周期控制
 */
export function createOfficeWordParagraphAdapter(options, scope = window) {
  const editor = scope.pad?.editor;
  const app = scope.App;
  const changes = app?.changesetManager;
  const service = scope.getLocalEditManager?.()?.getLocalEditService?.();
  const document = editor?.service?.getDocument?.();
  const plain = (text) =>
    typeof text === "string" && !/[\u0000-\u001f\u007f\ufffc]/u.test(text);
  if (
    !editor ||
    !changes ||
    !service ||
    !document ||
    typeof changes.addCommand !== "function" ||
    typeof changes.applyChunkToBase !== "function" ||
    typeof document.getRange !== "function" ||
    typeof document.readText !== "function" ||
    !/^[A-Fa-f0-9]{8}$/.test(options?.paragraphId ?? "") ||
    options.start !== 0 ||
    !plain(options.text) ||
    options.text.length > 4096 ||
    typeof options.onChange !== "function" ||
    typeof options.onPause !== "function"
  )
    throw new Error("unsupported_word_model");

  let text = options.text;
  let status = "active";
  let origin = "word";
  let composing = false;
  const hooks = [];
  const current = () =>
    scope.pad?.editor === editor &&
    scope.App === app &&
    app.changesetManager === changes &&
    scope.getLocalEditManager?.()?.getLocalEditService?.() === service;
  const idle = () =>
    service.isCommitting === false &&
    service.committingQueue?.length === 0 &&
    changes.composeCommands?.length === 0 &&
    changes.localEditCommands?.length === 0 &&
    changes.inFlightCommands?.size === 0 &&
    service.isGapFilling === false &&
    app.GlobalConfig?.isLocalEditChunkFinish === true;
  const read = (length) => document.readText(options.start, length);
  if (!current() || !idle() || read(text.length) !== text)
    throw new Error("word_baseline_mismatch");

  const pause = (reason) => {
    if (status !== "active") return;
    status = "paused";
    try {
      options.onPause(reason);
    } catch {
      /* 适配失败不能打断原生编辑。 */
    }
  };
  const applyToText = (base, edits) => {
    if (!Array.isArray(edits) || edits.length > 256)
      throw new Error("unsupported_word_operation");
    let next = base;
    const boundary = (index) =>
      !(
        index > 0 &&
        index < next.length &&
        /[\uD800-\uDBFF]/.test(next[index - 1]) &&
        /[\uDC00-\uDFFF]/.test(next[index])
      );
    for (const edit of edits) {
      if (
        !edit ||
        !Number.isSafeInteger(edit.index) ||
        edit.index < 0 ||
        edit.index > next.length ||
        !boundary(edit.index) ||
        !["insert", "delete"].includes(edit.kind)
      )
        throw new Error("invalid_word_range");
      if (edit.kind === "insert") {
        if (!plain(edit.text)) throw new Error("unsupported_word_structure");
        next = next.slice(0, edit.index) + edit.text + next.slice(edit.index);
      } else {
        if (
          !Number.isSafeInteger(edit.length) ||
          edit.length < 1 ||
          edit.index + edit.length > next.length ||
          !boundary(edit.index + edit.length)
        )
          throw new Error("invalid_word_range");
        next = next.slice(0, edit.index) + next.slice(edit.index + edit.length);
      }
      if (next.length > 4096) throw new Error("unsupported_word_size");
    }
    return next;
  };
  const normalize = (mutations) => {
    if (!Array.isArray(mutations) || mutations.length > 256)
      throw new Error("unsupported_word_operation");
    // TIPS: SDK 原生命令类的 toJSON 输出与 AI mutation wrapper 一致；structuredClone 会丢失该转换。
    const serialized = JSON.stringify(mutations);
    if (serialized.length > 512 * 1024)
      throw new Error("unsupported_word_size");
    const normalized = JSON.parse(serialized);
    const edits = [];
    for (const mutation of normalized) {
      if (mutation.ty === 1) {
        edits.push({
          kind: "insert",
          index: mutation.bi - options.start,
          text: mutation.s,
        });
      } else if (mutation.ty === 2) {
        edits.push({
          kind: "delete",
          index: mutation.bi - options.start,
          length: mutation.ei - mutation.bi,
        });
      } else if (mutation.ty === 3) {
        // 新插入文字的作者／字体提示不代表用户改变字符样式；其他属性均暂停，不能静默丢弃格式。
        const run = mutation.pr?.run;
        if (
          mutation.mt !== 101 ||
          mutation.mm !== 1 ||
          !run ||
          Object.keys(mutation.pr).some((key) => key !== "run") ||
          Object.keys(run).some((key) => !["author", "rFonts"].includes(key)) ||
          (run.rFonts &&
            (Object.keys(run.rFonts).some((key) => key !== "hint") ||
              run.rFonts.hint !== 2))
        )
          throw new Error("unsupported_word_format");
      } else throw new Error("unsupported_word_operation");
    }
    return edits;
  };
  const changed = (mutations, source) => {
    if (status !== "active") return;
    try {
      if (!current() || service.isGapFilling)
        throw new Error("word_model_invalidated");
      const edits = normalize(mutations);
      const next = applyToText(text, edits);
      if (read(next.length) !== next) throw new Error("word_model_diverged");
      text = next;
      if (edits.length)
        options.onChange({ paragraphId: options.paragraphId, source, edits });
    } catch (error) {
      pause(error.message || "word_adapter_failed");
    }
  };
  const hook = (key, after) => {
    const original = changes[key];
    const wrapped = function (...args) {
      const result = Reflect.apply(original, this, args);
      if (this === changes && status === "active") after(args);
      return result;
    };
    changes[key] = wrapped;
    hooks.push(() => {
      if (changes[key] === wrapped) changes[key] = original;
    });
  };
  hook("addCommand", ([command]) => changed(command.mutations, origin));
  hook("applyChunkToBase", ([input]) => {
    if (input?.deltaOpt?.undoOption?.fromLocalAiEdit === true)
      changed(input.mutationWrappers, "ai");
    else pause("word_model_reloaded");
  });
  const compositionStart = () => {
    composing = true;
  };
  const compositionEnd = () => {
    composing = false;
  };
  scope.document.addEventListener("compositionstart", compositionStart, true);
  scope.document.addEventListener("compositionend", compositionEnd, true);

  return {
    /** 将原生文本增量定点回写同一 SDK 模型；输入未提交时返回 busy，不排队或重试。 */
    applyRemote(edits) {
      if (status !== "active") return { status };
      if (!current()) {
        pause("word_model_invalidated");
        return { status };
      }
      if (composing || !idle()) return { status: "busy" };
      let started = false;
      try {
        const expected = applyToText(text, edits);
        if (read(text.length) !== text) throw new Error("word_model_diverged");
        origin = "cloud";
        for (const edit of edits) {
          const begin = options.start + edit.index;
          const end = begin + (edit.kind === "delete" ? edit.length : 0);
          const range = document.getRange(begin, end, {
            updateSelection: false,
          });
          if (range === editor.service.getSelection().getRange())
            throw new Error("word_range_not_independent");
          started = true;
          range.setText(edit.kind === "insert" ? edit.text : "");
          if (status !== "active") return { status: "unknown" };
        }
        if (text !== expected || read(expected.length) !== expected)
          throw new Error("word_write_unconfirmed");
        return { status: "applied" };
      } catch (error) {
        pause(error.message || "word_write_failed");
        return { status: started ? "unknown" : "rejected" };
      } finally {
        origin = "word";
      }
    },
    /** 释放本适配器的事件钩子；不恢复其他组件后来安装的钩子。 */
    dispose() {
      status = "disposed";
      hooks.reverse().forEach((remove) => remove());
      scope.document.removeEventListener(
        "compositionstart",
        compositionStart,
        true,
      );
      scope.document.removeEventListener(
        "compositionend",
        compositionEnd,
        true,
      );
    },
    /** 查询适配状态；paused 必须重新核对模型，不能自动激活。 */
    state() {
      return status;
    },
  };
}
