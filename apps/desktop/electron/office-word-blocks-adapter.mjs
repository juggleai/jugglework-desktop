/**
 * 读取固定 SDK 当前主文档中的段落身份及基础字符样式，不读磁盘或 HTML。
 * @param {any} scope 已就绪的 SDK 页面
 * @returns {Array<{id: string,start: number,text: string,kind: string,marks: any[]}>} 当前模型快照，仅用于对象校验
 */
export function readOfficeWordBlocks(scope = window) {
  const editor = scope.pad?.editor;
  const doc = editor?.service?.getDocument?.();
  if (!doc?.getParagraphs || !doc.getMainStoryRange)
    throw new Error("unsupported_word_model");
  const main = doc.getMainStoryRange(),
    collection = doc.getParagraphs();
  const count = collection.count();
  if (!Number.isSafeInteger(count) || count > 256)
    throw new Error("unsupported_word_size");
  const result = [];
  for (let i = 0; i < count; i++) {
    const paragraph = collection.item(i),
      range = paragraph.getRange();
    const start = range.begin(),
      end = range.end();
    if (start >= main.end()) continue;
    const raw = doc.readText(start, end - start);
    // SDK 主故事之后的固定保留标记不属于可编辑段落，不能作为正文上传。
    if (/^[\u000f\u001e]+$/.test(raw)) continue;
    if (
      end > main.end() ||
      !raw.endsWith("\r") ||
      /[\u0000-\u001f\ufffc]/.test(raw.slice(0, -1))
    )
      throw new Error("unsupported_word_structure");
    const text = raw.slice(0, -1),
      format = paragraph.getFormat(),
      id = format.getParaId();
    if (
      !/^[a-f0-9]{8}$/i.test(id) ||
      text.length > 4096 ||
      result.some((p) => p.id === id)
    )
      throw new Error("unsupported_word_model");
    const attrs = format.getAttributes(),
      numId = attrs.numPr?.numId?.val;
    let kind = "text";
    if (numId && numId !== "0") {
      const level = attrs.numPr?.ilvl?.val ?? 0;
      const style = editor.service.getNumbering().getRawListStyleset(numId)?.[
        level
      ];
      if (level !== 0 || !style || ![1, 24].includes(style.listFormat))
        throw new Error("unsupported_word_list");
      kind = style.listFormat === 24 ? "bulleted" : "numbered";
    } else {
      const outline = format.getOutlineLevel();
      if (Number.isInteger(outline) && outline >= 0 && outline <= 5)
        kind = `h${outline + 1}`;
      else if (outline !== 9) throw new Error("unsupported_word_heading");
    }
    const spans = doc
      .getRange(start, end - 1, { updateSelection: false })
      .getSpans();
    const marks = [];
    for (let j = 0; j < spans.count(); j++) {
      const span = spans.item(j),
        r = span.getRange();
      const begin = Math.max(start, r.begin()),
        finish = Math.min(end - 1, r.end());
      if (finish <= begin) continue;
      const font = span.getFont(),
        bold = font.isBold(),
        italic = font.isItalic();
      if (typeof bold !== "boolean" || typeof italic !== "boolean")
        throw new Error("unsupported_word_format");
      const previous = marks.at(-1);
      if (
        previous &&
        previous.index + previous.length === begin - start &&
        previous.bold === bold &&
        previous.italic === italic
      )
        previous.length += finish - begin;
      else
        marks.push({
          index: begin - start,
          length: finish - begin,
          bold,
          italic,
        });
    }
    if (
      marks.reduce((n, r) => n + r.length, 0) !== text.length ||
      marks.some(
        (r, i) =>
          r.index !== (i ? marks[i - 1].index + marks[i - 1].length : 0),
      )
    )
      throw new Error("word_spans_unconfirmed");
    result.push({ id, start, text, kind, marks });
  }
  if (!result.length || result.length > 128)
    throw new Error("unsupported_word_size");
  return result;
}

/**
 * 适配文本、加粗及斜体；显式提供 onStructure 时额外实验支持普通无格式段落的单次拆并。
 * @param {{blocks: any[],onChange: (change: any) => void,onPause: (reason: string) => void,onStructure?: (change: any) => void}} options 当前已核实的对象快照与回调
 * @param {any} scope 当前 SDK 页面
 * @param {(scope: any) => any[]} read 当前模型读取函数；注入仅供源码验收驱动
 */
export function createOfficeWordBlocksAdapter(
  options,
  scope = window,
  read = readOfficeWordBlocks,
) {
  const editor = scope.pad?.editor,
    app = scope.App,
    changes = app?.changesetManager;
  const service = scope.getLocalEditManager?.()?.getLocalEditService?.();
  if (
    !changes?.addCommand ||
    !changes.applyChunkToBase ||
    !service ||
    typeof options?.onChange !== "function" ||
    typeof options.onPause !== "function"
  )
    throw new Error("unsupported_word_model");
  let blocks = read(scope),
    status = "active",
    origin = "word",
    composing = false,
    revision = 0;
  /** @type {{source:string,kind:'split'|'merge',index:number,offset:number,before:any[],after:any[],revision:number}|undefined} */
  let lastStructure;
  if (JSON.stringify(blocks) !== JSON.stringify(options.blocks))
    throw new Error("word_baseline_mismatch");
  const hooks = [];
  const current = () =>
    scope.pad?.editor === editor &&
    scope.App === app &&
    app.changesetManager === changes &&
    scope.getLocalEditManager?.()?.getLocalEditService?.() === service;
  const idle = () =>
    !composing &&
    service.isCommitting === false &&
    service.committingQueue?.length === 0 &&
    changes.composeCommands?.length === 0 &&
    changes.localEditCommands?.length === 0 &&
    changes.inFlightCommands?.size === 0 &&
    service.isGapFilling === false &&
    app.GlobalConfig?.isLocalEditChunkFinish === true;
  if (!idle()) throw new Error("word_not_ready");
  const pause = (reason) => {
    if (status === "active") {
      status = "paused";
      try {
        options.onPause(reason);
      } catch {}
    }
  };
  const state = (block) => ({
    text: block.text,
    kind: block.kind,
    marks: block.marks,
  });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const boundary = (text, index) =>
    !(
      index > 0 &&
      index < text.length &&
      /[\uD800-\uDBFF]/.test(text[index - 1]) &&
      /[\uDC00-\uDFFF]/.test(text[index])
    );
  const editText = (base, edits) => {
    if (!Array.isArray(edits) || edits.length > 256)
      throw new Error("unsupported_word_operation");
    let text = base;
    for (const edit of edits) {
      if (
        !Number.isSafeInteger(edit.index) ||
        edit.index < 0 ||
        edit.index > text.length ||
        !boundary(text, edit.index)
      )
        throw new Error("invalid_word_range");
      if (edit.kind === "insert") {
        if (
          typeof edit.text !== "string" ||
          /[\u0000-\u001f\ufffc]/.test(edit.text)
        )
          throw new Error("unsupported_word_structure");
        text = text.slice(0, edit.index) + edit.text + text.slice(edit.index);
      } else if (edit.kind === "delete") {
        if (
          !Number.isSafeInteger(edit.length) ||
          edit.length < 1 ||
          edit.index + edit.length > text.length ||
          !boundary(text, edit.index + edit.length)
        )
          throw new Error("invalid_word_range");
        text = text.slice(0, edit.index) + text.slice(edit.index + edit.length);
      } else throw new Error("unsupported_word_operation");
      if (text.length > 4096) throw new Error("unsupported_word_size");
    }
    return text;
  };
  const validateMarks = (text, marks) => {
    if (!Array.isArray(marks) || marks.length > 256)
      throw new Error("unsupported_word_format");
    let end = 0;
    for (const r of marks) {
      if (
        r.index !== end ||
        !Number.isSafeInteger(r.length) ||
        r.length < 1 ||
        typeof r.bold !== "boolean" ||
        typeof r.italic !== "boolean" ||
        end + r.length > text.length ||
        !boundary(text, end) ||
        !boundary(text, end + r.length)
      )
        throw new Error("invalid_word_marks");
      end += r.length;
    }
    if (end !== text.length) throw new Error("invalid_word_marks");
  };
  const markCells = (block) => {
    validateMarks(block.text, block.marks);
    return block.marks.flatMap((mark) =>
      Array.from({ length: mark.length }, () => ({
        bold: mark.bold,
        italic: mark.italic,
      })),
    );
  };
  const compactMarks = (cells) => {
    const marks = [];
    for (const cell of cells) {
      const previous = marks.at(-1);
      if (
        previous &&
        previous.bold === cell.bold &&
        previous.italic === cell.italic
      )
        previous.length++;
      else
        marks.push({
          index: marks.reduce((total, mark) => total + mark.length, 0),
          length: 1,
          bold: cell.bold,
          italic: cell.italic,
        });
    }
    return marks;
  };
  /** TIPS: 拆并只投影已有字符身份及基础 marks，不推断段落样式或新增正文协议。 */
  const projectStructureStates = (before, split, offset) => {
    if (
      before.length !== (split ? 1 : 2) ||
      before.some((block) => block.kind !== "text")
    )
      throw new Error("unsupported_word_structure");
    const firstCells = markCells(before[0]);
    if (split)
      return [
        {
          text: before[0].text.slice(0, offset),
          kind: "text",
          marks: compactMarks(firstCells.slice(0, offset)),
        },
        {
          text: before[0].text.slice(offset),
          kind: "text",
          marks: compactMarks(firstCells.slice(offset)),
        },
      ];
    return [
      {
        text: before[0].text + before[1].text,
        kind: "text",
        marks: compactMarks(firstCells.concat(markCells(before[1]))),
      },
    ];
  };
  const identity = (block) => ({ id: block.id, ...state(block) });
  const structural = (raw, next, source) => {
    if (typeof options.onStructure !== "function")
      throw new Error("unsupported_word_structure");
    const texts = raw.filter((m) => m.ty === 1 || m.ty === 2);
    if (
      texts.length !== 1 ||
      raw.some(
        (m) =>
          m.ty !== 1 &&
          m.ty !== 2 &&
          !(m.ty === 3 && [101, 102].includes(m.mt)),
      )
    )
      throw new Error("unsupported_word_structure");
    const mutation = texts[0],
      split = mutation.ty === 1 && mutation.s === "\r";
    const index = blocks.findIndex(
      (b) => mutation.bi >= b.start && mutation.bi <= b.start + b.text.length,
    );
    if (
      index < 0 ||
      (split
        ? next.length !== blocks.length + 1
        : mutation.ty !== 2 ||
          mutation.ei !== mutation.bi + 1 ||
          next.length !== blocks.length - 1)
    )
      throw new Error("unsupported_word_structure");
    const before = blocks.slice(index, index + (split ? 1 : 2)),
      after = next.slice(index, index + (split ? 2 : 1));
    const offset = mutation.bi - before[0].start;
    if (
      before.length !== (split ? 1 : 2) ||
      after.length !== (split ? 2 : 1) ||
      !boundary(before[0].text, offset)
    )
      throw new Error("unsupported_word_structure");
    const projectedStates = projectStructureStates(before, split, offset);
    // TIPS: SDK 段落属性属于结束符；拆段原 ID 留右段，合并也保留右段 ID，不能套用 BlockSuite 的左段身份。
    if (
      split
        ? after[1].id !== before[0].id ||
          blocks.some((b) => b.id === after[0].id) ||
          after[0].text !== before[0].text.slice(0, offset) ||
          after[1].text !== before[0].text.slice(offset)
        : offset !== before[0].text.length ||
          after[0].id !== before[1].id ||
          after[0].text !== before[0].text + before[1].text
    )
      throw new Error("word_structure_changed");
    if (!same(after.map(state), projectedStates))
      throw new Error("word_structure_changed");
    const expected = blocks.map(identity);
    expected.splice(index, before.length, ...after.map(identity));
    if (!same(expected, next.map(identity)))
      throw new Error("word_structure_changed");
    for (const m of raw.filter((m) => m.ty === 3)) {
      const pr = m.pr;
      const allowed =
        m.mt === 101
          ? ["rFonts", "isPlaceholder", "author"]
          : ["paraId", "ind", "pStyle", "pBdr", "pStyleI", "taskPr", "taskPrI"];
      const key = m.mt === 101 ? "run" : "paragraph",
        value = pr?.[key];
      if (
        !value ||
        Object.keys(pr).some((k) => k !== key) ||
        Object.keys(value).some((k) => !allowed.includes(k))
      )
        throw new Error("unsupported_word_format");
      if (
        m.mt === 101 &&
        (m.bi !== mutation.bi ||
          m.ei !== mutation.bi + 1 ||
          Object.keys(value.rFonts || {}).some((k) => k !== "hint"))
      )
        throw new Error("unsupported_word_format");
      if (
        m.mt === 102 &&
        (Object.keys(value.taskPr || {}).length ||
          Object.keys(value.ind || {}).length ||
          Object.keys(value.pStyle || {}).length ||
          Object.keys(value.pBdr || {}).some((k) => k !== "bottom") ||
          Object.keys(value.pBdr?.bottom || {}).length)
      )
        throw new Error("unsupported_word_format");
    }
    blocks = next;
    lastStructure = {
      source,
      kind: split ? "split" : "merge",
      index,
      offset,
      before: before.map(identity),
      after: after.map(identity),
      revision: ++revision,
    };
    options.onStructure(lastStructure);
  };
  const after = (mutations, source) => {
    if (status !== "active") return;
    try {
      if (!current() || service.isGapFilling)
        throw new Error("word_model_invalidated");
      const serialized = JSON.stringify(mutations);
      if (serialized.length > 512 * 1024)
        throw new Error("unsupported_word_size");
      const raw = JSON.parse(serialized);
      if (!Array.isArray(raw) || raw.length > 256)
        throw new Error("unsupported_word_operation");
      const live = read(scope);
      if (live.length !== blocks.length) {
        structural(raw, live, source);
        return;
      }
      const simulated = blocks.map((b) => ({ ...b, edits: [] }));
      let precedingInsert;
      for (const mutation of raw) {
        if (mutation.ty === 1 || mutation.ty === 2) {
          const target = simulated.find(
            (b) =>
              mutation.bi >= b.start && mutation.bi <= b.start + b.text.length,
          );
          if (!target) throw new Error("unsupported_word_structure");
          const edit =
            mutation.ty === 1
              ? {
                  kind: "insert",
                  index: mutation.bi - target.start,
                  text: mutation.s,
                }
              : {
                  kind: "delete",
                  index: mutation.bi - target.start,
                  length: mutation.ei - mutation.bi,
                };
          const previousLength = target.text.length;
          target.text = editText(target.text, [edit]);
          target.edits.push(edit);
          for (const sibling of simulated.slice(simulated.indexOf(target) + 1))
            sibling.start += target.text.length - previousLength;
          precedingInsert =
            mutation.ty === 1
              ? { begin: mutation.bi, end: mutation.bi + mutation.s.length }
              : undefined;
        } else if (mutation.ty === 3 && mutation.mt === 101) {
          const run = mutation.pr?.run;
          // TIPS: 标题输入会紧跟一个同范围的默认字号／颜色命令；仅接受该插入附属命令，不接受单独改字号或颜色。
          const insertDefaults =
            mutation.mm === 1 &&
            precedingInsert?.begin === mutation.bi &&
            precedingInsert?.end === mutation.ei;
          const allowed = [
            "b",
            "bCs",
            "i",
            "iCs",
            "author",
            "rFonts",
            "isPlaceholderI",
            ...(insertDefaults ? ["sz", "szCs", "color"] : []),
          ];
          if (
            !run ||
            Object.keys(mutation.pr).some((k) => k !== "run") ||
            Object.keys(run).some((k) => !allowed.includes(k)) ||
            (run.rFonts &&
              Object.keys(run.rFonts).some(
                (k) =>
                  ![
                    "hint",
                    ...(insertDefaults
                      ? ["ascii", "hAnsi", "eastAsia", "cs"]
                      : []),
                  ].includes(k),
              ))
          )
            throw new Error("unsupported_word_format");
          // TIPS: i={} 等属性不能按对象存在判真；最终值由同一活跃模型的 Font API 读取。
        } else throw new Error("unsupported_word_structure");
      }
      const next = live;
      if (
        next.length !== blocks.length ||
        next.some(
          (b, i) =>
            b.id !== blocks[i].id ||
            b.kind !== blocks[i].kind ||
            b.text !== simulated[i].text ||
            b.start !== simulated[i].start,
        )
      )
        throw new Error("word_structure_changed");
      const frames = next.flatMap((block, i) =>
        same(state(block), state(blocks[i]))
          ? []
          : [
              {
                paragraphId: block.id,
                before: state(blocks[i]),
                after: state(block),
                edits: simulated[i].edits,
              },
            ],
      );
      blocks = next;
      if (frames.length)
        options.onChange({ source, frames, revision: ++revision });
    } catch (error) {
      pause(error.message || "word_adapter_failed");
    }
  };
  const hook = (key, callback) => {
    const original = changes[key];
    const wrapped = function (...args) {
      const result = Reflect.apply(original, this, args);
      if (this === changes && status === "active") callback(args);
      return result;
    };
    changes[key] = wrapped;
    hooks.push(() => {
      if (changes[key] === wrapped) changes[key] = original;
    });
  };
  hook("addCommand", ([c]) => after(c.mutations, origin));
  hook("applyChunkToBase", ([c]) =>
    c?.deltaOpt?.undoOption?.fromLocalAiEdit === true
      ? after(c.mutationWrappers, "ai")
      : pause("word_model_reloaded"),
  );
  const startComposition = () => {
      composing = true;
    },
    endComposition = () => {
      composing = false;
    };
  scope.document.addEventListener("compositionstart", startComposition, true);
  scope.document.addEventListener("compositionend", endComposition, true);
  return {
    /** 返回本实例的模型变更代次，用于在写入前拒绝已经过时的远端投影。 */
    revision() {
      return revision;
    },
    /** 读取当前实例的已核实对象快照；不暴露 SDK 对象或历史字符指针。 */
    snapshot() {
      if (status === "active" && (!current() || !same(read(scope), blocks)))
        pause("word_model_invalidated");
      return { status, revision, blocks: blocks.map(identity) };
    },
    /**
     * 仅在请求代次仍为当前值时回写；期间发生真实 Word 输入则零写入返回 stale，不暂停或覆盖输入。
     * @param {any[]} frames 已核实的远端文本投影
     * @param {number} expectedRevision 生成投影前读取的 Word 代次
     */
    applyRemoteAtRevision(frames, expectedRevision) {
      if (status !== "active") return { status };
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision !== revision
      )
        return { status: "stale", revision };
      return { ...this.applyRemote(frames), revision };
    },
    /** 按当前 Word 代次执行结构回写；过期结果不进入 SDK。 */
    applyRemoteStructureAtRevision(request, expectedRevision) {
      if (status !== "active") return { status };
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision !== revision
      )
        return { status: "stale", revision };
      const result = this.applyRemoteStructure(request);
      return {
        ...result,
        revision,
        ...(result.status === "applied"
          ? { blocks: blocks.map(identity) }
          : {}),
      };
    },
    /**
     * 在同一活跃模型拆并一个普通段落边界，返回实际新身份，不覆盖正文或自动重放。
     * @param {{kind: 'split'|'merge',before: any[],offset: number}} request 已复核的受影响 Word 对象和边界
     * @returns {{status: string,change?: any}} 成功时附实际身份映射；写后未确认返回 unknown
     */
    applyRemoteStructure(request) {
      if (status !== "active") return { status };
      if (!current()) {
        pause("word_model_invalidated");
        return { status };
      }
      if (!idle()) return { status: "busy" };
      let started = false;
      try {
        if (
          typeof options.onStructure !== "function" ||
          !same(read(scope), blocks) ||
          !["split", "merge"].includes(request.kind)
        )
          throw new Error("word_baseline_mismatch");
        const split = request.kind === "split",
          index = blocks.findIndex((b) => b.id === request.before?.[0]?.id),
          before = blocks.slice(index, index + (split ? 1 : 2));
        if (
          index < 0 ||
          before.length !== (split ? 1 : 2) ||
          !same(before.map(identity), request.before) ||
          !Number.isSafeInteger(request.offset) ||
          request.offset < 0 ||
          request.offset > before[0].text.length ||
          !boundary(before[0].text, request.offset) ||
          (!split && request.offset !== before[0].text.length) ||
          (split && blocks.length >= 128) ||
          (!split && before.reduce((n, b) => n + b.text.length, 0) > 4096)
        )
          throw new Error("word_baseline_mismatch");
        projectStructureStates(before, split, request.offset);
        origin = "cloud";
        lastStructure = undefined;
        const begin = before[0].start + request.offset,
          range = editor.service
            .getDocument()
            .getRange(begin, begin + (split ? 0 : 1), {
              updateSelection: false,
            });
        started = true;
        if (split) range.insertParagraph();
        else range.delete();
        if (
          status !== "active" ||
          !lastStructure ||
          lastStructure.kind !== request.kind ||
          !same(lastStructure.before, request.before)
        )
          throw new Error("word_write_unconfirmed");
        return { status: "applied", change: lastStructure };
      } catch (error) {
        pause(error.message || "word_adapter_failed");
        return { status: started ? "unknown" : "rejected" };
      } finally {
        origin = "word";
      }
    },
    /** 对当前段落实例定点回写基础文本／字符样式，不重写未修改对象或磁盘文件。 */
    applyRemote(frames) {
      if (status !== "active") return { status };
      if (!current()) {
        pause("word_model_invalidated");
        return { status };
      }
      if (!idle()) return { status: "busy" };
      let started = false;
      try {
        if (
          !Array.isArray(frames) ||
          frames.length > 128 ||
          !same(read(scope), blocks)
        )
          throw new Error("word_baseline_mismatch");
        if (
          frames.reduce((n, frame) => n + (frame.edits?.length ?? 257), 0) > 256
        )
          throw new Error("unsupported_word_operation");
        const seen = new Set();
        for (const frame of frames) {
          const block = blocks.find((b) => b.id === frame.paragraphId);
          if (
            !block ||
            seen.has(block.id) ||
            !same(state(block), frame.before) ||
            frame.after.kind !== block.kind ||
            editText(block.text, frame.edits) !== frame.after.text
          )
            throw new Error("word_baseline_mismatch");
          validateMarks(frame.after.text, frame.after.marks);
          seen.add(block.id);
        }
        origin = "cloud";
        const doc = editor.service.getDocument();
        for (const frame of frames) {
          for (const edit of frame.edits) {
            const block = blocks.find((b) => b.id === frame.paragraphId),
              begin = block.start + edit.index;
            started = true;
            doc
              .getRange(
                begin,
                begin + (edit.kind === "delete" ? edit.length : 0),
                { updateSelection: false },
              )
              .setText(edit.kind === "insert" ? edit.text : "");
            if (status !== "active") return { status: "unknown" };
          }
          for (const run of frame.after.marks) {
            const block = blocks.find((b) => b.id === frame.paragraphId);
            const font = doc
              .getRange(
                block.start + run.index,
                block.start + run.index + run.length,
                { updateSelection: false },
              )
              .getFont();
            if (font.isBold() !== run.bold) {
              started = true;
              font.setBold(run.bold);
            }
            if (status !== "active") return { status: "unknown" };
            if (font.isItalic() !== run.italic) {
              started = true;
              font.setItalic(run.italic);
            }
            if (status !== "active") return { status: "unknown" };
          }
          if (
            !same(
              state(blocks.find((b) => b.id === frame.paragraphId)),
              frame.after,
            )
          )
            throw new Error("word_write_unconfirmed");
        }
        return { status: "applied" };
      } catch (error) {
        pause(error.message || "word_adapter_failed");
        return { status: started ? "unknown" : "rejected" };
      } finally {
        origin = "word";
      }
    },
    /** 查询状态，暂停后不自动恢复。 */
    state() {
      return status;
    },
    /** 释放当前适配器，不更改其他组件后来安装的事件钩子。 */
    dispose() {
      status = "disposed";
      hooks.reverse().forEach((f) => f());
      scope.document.removeEventListener(
        "compositionstart",
        startComposition,
        true,
      );
      scope.document.removeEventListener(
        "compositionend",
        endComposition,
        true,
      );
    },
  };
}
