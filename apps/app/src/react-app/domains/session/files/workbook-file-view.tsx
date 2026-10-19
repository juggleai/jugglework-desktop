import * as React from "react";
import * as XLSX from "xlsx";
import { DelimitedFileView } from "./delimited-file-view";
import { serializeDelimitedSpreadsheet } from "../artifacts/artifact-spreadsheet-model";
import { PreviewError } from "../artifacts/preview";

/**
 * 工作簿多表预览，显示格式化值与公式缓存，不序列化写回或丢弃其他工作表。
 * @param props 工作簿原始字节
 */
export function WorkbookFileView({ bytes }: { bytes: ArrayBuffer }) {
  const result = React.useMemo(() => {
    try {
      const book = XLSX.read(bytes, { type: "array" });
      return {
        sheets: book.SheetNames.map((name) => {
          const sheet = book.Sheets[name]!;
          // TIPS: 缺少计算缓存时显示公式本身，不假装已重算；仅修改预览模型，不写回文件。
          for (const [address, cell] of Object.entries(sheet))
            if (!address.startsWith("!") && cell.f && cell.v == null)
              sheet[address] = {
                ...cell,
                t: "s",
                v: `=${cell.f}`,
                w: undefined,
              };
          return {
            name,
            content: serializeDelimitedSpreadsheet(
              "preview.csv",
              XLSX.utils
                .sheet_to_json<unknown[]>(sheet, {
                  header: 1,
                  raw: false,
                  defval: "",
                  blankrows: true,
                })
                .map((row) => row.map((value) => String(value ?? ""))),
            ),
          };
        }),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [bytes]);
  const [selected, setSelected] = React.useState(0);
  React.useEffect(() => setSelected(0), [bytes]);
  if (result.error) return <PreviewError message={result.error} />;
  const sheet = result.sheets?.[selected] ?? result.sheets?.[0];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {sheet ? (
          <DelimitedFileView name="preview.csv" content={sheet.content} />
        ) : null}
      </div>
      <div
        className="flex shrink-0 gap-1 overflow-x-auto border-t border-border bg-muted/40 p-1"
        role="tablist"
      >
        {result.sheets?.map((item, index) => (
          <button
            key={item.name}
            type="button"
            role="tab"
            aria-selected={index === selected}
            className={`shrink-0 rounded px-3 py-1.5 text-sm ${index === selected ? "bg-background font-medium text-primary shadow-sm" : "text-muted-foreground hover:bg-muted"}`}
            onClick={() => setSelected(index)}
          >
            {item.name}
          </button>
        ))}
      </div>
    </div>
  );
}
