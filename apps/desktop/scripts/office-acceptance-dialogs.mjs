import assert from "node:assert/strict";

// Synthetic dialog choices only. Production office.close, native save/close and
// real FileWindow close handlers remain intact. Unexpected dialogs fail closed.
export function syntheticDialogChoices(dialog, inspect) {
  const original = dialog.showMessageBox;
  const queue = [], reports = [];
  dialog.showMessageBox = async (...args) => {
    const options = args.at(-1), choice = queue.shift();
    assert.ok(choice, "Unexpected native dialog; no synthetic response queued");
    assert.equal(options.title, "关闭文档");
    assert.deepEqual(options.buttons, ["保存并关闭", "放弃修改", "取消"]);
    assert.equal(options.cancelId, 2);
    await inspect();
    reports.push({ synthetic: true, choice, buttons: options.buttons });
    return { response: { save: 0, discard: 1, cancel: 2 }[choice], checkboxChecked: false };
  };
  return {
    reports,
    enqueue(choice) { assert.ok(["cancel", "save", "discard"].includes(choice)); assert.equal(queue.length, 0); queue.push(choice); },
    assertConsumed() { assert.equal(queue.length, 0); },
    restore() { dialog.showMessageBox = original; },
  };
}
