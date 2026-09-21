export type TextInsertionSelection = {
  insertText: (text: string) => void;
};

export function insertTextAtSelection(
  text: string,
  adapter: {
    getSelection: () => unknown;
    isRangeSelection: (selection: unknown) => selection is TextInsertionSelection;
    selectEnd: () => void;
  },
) {
  if (!text) return;
  let selection = adapter.getSelection();
  if (!adapter.isRangeSelection(selection)) {
    adapter.selectEnd();
    selection = adapter.getSelection();
  }
  if (adapter.isRangeSelection(selection)) selection.insertText(text);
}
