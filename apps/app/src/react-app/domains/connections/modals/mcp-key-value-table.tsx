/** @jsxImportSource react */
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { KeyValueRow } from "../mcp-kv-entries";
import { isValidEnvKey, isValidHeaderKey } from "../mcp-kv-entries";
import { t } from "@/i18n";

/**
 * MCP 配置里的键值对编辑表（环境变量 / 请求头共用）。
 * @param kind 键类型，决定键名校验规则与占位文案
 * @param rows 当前行
 * @param onChange 行变更回调
 * @param footer 表格底部的附加内容，用于挂建议区与安全提示
 */
export function McpKeyValueTable({ kind, rows, onChange, footer }: {
  kind: "env" | "header";
  rows: KeyValueRow[];
  onChange: (next: KeyValueRow[]) => void;
  footer?: React.ReactNode;
}) {
  const validate = kind === "env" ? isValidEnvKey : isValidHeaderKey;

  const update = (index: number, patch: Partial<KeyValueRow>) => {
    onChange(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-dls-secondary">
        {kind === "env" ? t("mcp.environment") : t("mcp.headers")}
      </div>

      {rows.length > 0 ? (
        <div className="space-y-1.5">
          {rows.map((row, index) => {
            const keyText = row.key.trim();
            const invalid = Boolean(keyText) && !validate(keyText);
            return (
              <div key={index} className="flex items-start gap-1.5">
                <div className="w-[38%] shrink-0">
                  <input
                    aria-label={kind === "env" ? t("mcp.environment_key") : t("mcp.header_key")}
                    value={row.key}
                    placeholder={kind === "env" ? "API_KEY" : "Authorization"}
                    onChange={(event) => update(index, { key: event.currentTarget.value })}
                    className={`w-full rounded-lg border bg-dls-surface px-2.5 py-1.5 font-mono text-xs text-dls-text shadow-sm placeholder:text-dls-secondary focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)] ${
                      invalid ? "border-red-7" : "border-dls-border"
                    }`}
                  />
                </div>
                <input
                  aria-label={t("mcp.key_value")}
                  value={row.value}
                  placeholder={t("mcp.key_value_placeholder")}
                  onChange={(event) => update(index, { value: event.currentTarget.value })}
                  className="min-w-0 flex-1 rounded-lg border border-dls-border bg-dls-surface px-2.5 py-1.5 font-mono text-xs text-dls-text shadow-sm placeholder:text-dls-secondary focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("mcp.remove_row")}
                  className="shrink-0 text-dls-secondary hover:text-red-11"
                  onClick={() => onChange(rows.filter((_, position) => position !== index))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}

      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        <Plus className="size-3.5" />
        {t("mcp.add_row")}
      </Button>

      {footer}
    </div>
  );
}
