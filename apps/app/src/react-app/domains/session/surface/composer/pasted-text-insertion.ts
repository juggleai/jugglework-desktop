import { $getSelection, $isRangeSelection } from "lexical";

export function insertPastedText(text: string) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  selection.insertRawText(text);
  return true;
}
