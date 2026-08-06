/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { desktopBridge } from "@/app/lib/desktop";
import { t } from "@/i18n";

/**
 * 项目指令编辑弹窗：读写项目根 AGENTS.md，设定项目背景与规范。
 * @param open 是否打开
 * @param projectDir 项目根目录
 * @param onClose 关闭回调
 */
export function InstructionsModal({ open, projectDir, onClose }: {
  open: boolean;
  projectDir: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !projectDir) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void desktopBridge
      .readProjectInstructions(projectDir)
      .then((result) => {
        if (cancelled) return;
        setContent(result?.content ?? "");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectDir]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await desktopBridge.writeProjectInstructions(projectDir, content);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("project_extensions.instructions_title")}</DialogTitle>
          <DialogDescription>{t("project_extensions.instructions_desc")}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-12 text-dls-secondary">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <textarea
            value={content}
            onChange={(event) => setContent(event.currentTarget.value)}
            rows={16}
            placeholder={t("project_extensions.instructions_placeholder")}
            className="w-full resize-y rounded-lg border border-dls-border bg-dls-surface px-3 py-2 font-mono text-xs font-normal outline-none focus:ring-2 focus:ring-dls-accent/20"
          />
        )}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving || loading}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
