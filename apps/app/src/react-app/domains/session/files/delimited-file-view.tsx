import * as React from "react";
import {
  parseDelimitedSpreadsheet,
  serializeDelimitedSpreadsheet,
} from "../artifacts/artifact-spreadsheet-model";

/**
 * CSV/TSV 共用表格显示与单元格编辑，修改保存在文件面板的统一文本草稿中。
 * @param props 文件名、当前内容、编辑状态及草稿变更回调
 */
export function DelimitedFileView({
  name,
  content,
  editable = false,
  onChange,
}: {
  name: string;
  content: string;
  editable?: boolean;
  onChange?: (content: string) => void;
}) {
  const rows = React.useMemo(
    () => parseDelimitedSpreadsheet(name, content),
    [name, content],
  );
  const width = rows.reduce((max, row) => Math.max(max, row.length), 1);
  const columnName = (index: number) => {
    let label = "";
    for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
      label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
    return label;
  };
  return (
    <div
      className="h-full min-h-0 overflow-auto"
      data-testid="delimited-file-view"
    >
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-muted">
          <tr>
            <th className="w-10 border-b border-e border-border px-2 py-2" />
            {Array.from({ length: width }, (_, column) => (
              <th
                key={column}
                scope="col"
                className="min-w-36 border-b border-e border-border px-3 py-2 text-center font-medium text-muted-foreground"
              >
                {columnName(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <th
                scope="row"
                className="border-b border-e border-border bg-muted/50 px-2 py-2 text-center font-normal text-muted-foreground"
              >
                {rowIndex + 1}
              </th>
              {Array.from({ length: width }, (_, column) => (
                <td
                  key={column}
                  className="border-b border-e border-border p-0 align-top"
                >
                  {editable ? (
                    <input
                      aria-label={`${columnName(column)}${rowIndex + 1}`}
                      className="h-9 w-full min-w-36 bg-transparent px-3 outline-none focus:bg-muted/50"
                      value={row[column] ?? ""}
                      onChange={(event) => {
                        // TIPS: 直接更新统一草稿，不维护第二份局部编辑状态，导出和关闭都能感知未保存内容。
                        const next = rows.map((item) => [...item]);
                        next[rowIndex]![column] = event.target.value;
                        onChange?.(serializeDelimitedSpreadsheet(name, next));
                      }}
                    />
                  ) : (
                    <div className="min-h-9 whitespace-pre-wrap break-words px-3 py-2">
                      {row[column] ?? ""}
                    </div>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
