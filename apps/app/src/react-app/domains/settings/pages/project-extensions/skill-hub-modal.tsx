/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Loader2, Search } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { desktopBridge } from "@/app/lib/desktop";
import type { SkillHubSkill } from "@/app/lib/desktop-types";
import { t } from "@/i18n";
import { SkillAvatar } from "./skill-avatar";

type HubTab = "recommended" | "skillhub" | "installed";

const PAGE_SIZE = 12;

const TAB_SORT: Record<HubTab, string> = {
  recommended: "downloads",
  skillhub: "newest",
  installed: "newest",
};

function skillKey(skill: Pick<SkillHubSkill, "namespace" | "slug">): string {
  return `${skill.namespace}/${skill.slug}`;
}

/**
 * 技能中心弹窗：从 SkillHub 检索技能，支持搜索、多选与批量安装。
 * @param open 是否打开
 * @param projectDir 项目根目录（安装落点）
 * @param installedSlugs 已安装技能的 slug/name 小写集合，用于标记「已安装」
 * @param onClose 关闭回调
 * @param onInstalled 安装完成后刷新回调
 */
export function SkillHubModal({ open, projectDir, installedSlugs, onClose, onInstalled }: {
  open: boolean;
  projectDir: string;
  installedSlugs: Set<string>;
  onClose: () => void;
  onInstalled: () => void | Promise<void>;
}) {
  const [tab, setTab] = useState<HubTab>("skillhub");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [items, setItems] = useState<SkillHubSkill[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const requestRef = useRef(0);

  // 搜索输入防抖
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const isInstalled = useCallback(
    (skill: SkillHubSkill) =>
      installedSlugs.has(skill.slug.toLowerCase()) ||
      installedSlugs.has(skill.displayName.trim().toLowerCase()),
    [installedSlugs],
  );

  const runSearch = useCallback(async (nextPage: number, append: boolean) => {
    const token = requestRef.current + 1;
    requestRef.current = token;
    setLoading(true);
    setError(null);
    try {
      const result = await desktopBridge.skillhubSearch({
        q: debouncedQuery,
        sort: TAB_SORT[tab],
        page: nextPage,
        size: PAGE_SIZE,
      });
      if (requestRef.current !== token) return;
      setTotal(result.total);
      setPage(result.page);
      setItems((current) => (append ? [...current, ...result.items] : result.items));
    } catch (cause) {
      if (requestRef.current !== token) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestRef.current === token) setLoading(false);
    }
  }, [debouncedQuery, tab]);

  // 打开、切 tab 或搜索词变化时重新拉第一页。
  useEffect(() => {
    if (!open) return;
    void runSearch(0, false);
  }, [open, runSearch]);

  // 关闭时重置选择态。
  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setInstallError(null);
    }
  }, [open]);

  const visibleItems = useMemo(() => {
    if (tab === "installed") return items.filter((item) => isInstalled(item));
    return items;
  }, [items, tab, isInstalled]);

  const toggleSelect = (skill: SkillHubSkill) => {
    if (isInstalled(skill)) return; // 已安装项不可再选
    const key = skillKey(skill);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleConfirm = async () => {
    const targets = items.filter((item) => selected.has(skillKey(item)) && !isInstalled(item));
    if (targets.length === 0) {
      onClose();
      return;
    }
    setInstalling(true);
    setInstallError(null);
    const failures: string[] = [];
    for (const skill of targets) {
      try {
        const result = await desktopBridge.skillhubInstall({
          projectDir,
          namespace: skill.namespace,
          slug: skill.slug,
        });
        if (!result?.ok) failures.push(`${skill.displayName}: ${result?.stderr ?? result?.message ?? "failed"}`);
      } catch (cause) {
        failures.push(`${skill.displayName}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    await onInstalled();
    setInstalling(false);
    if (failures.length > 0) {
      setInstallError(failures.join("\n"));
      setSelected(new Set());
    } else {
      onClose();
    }
  };

  const selectedCount = selected.size;
  const hasMore = items.length < total;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !installing) onClose(); }}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] max-w-[1000px] flex-col sm:max-w-[1000px]">
        {/* TIPS: 标题、搜索与页签同处一行，右侧留出关闭按钮的位置。 */}
        <DialogHeader className="flex-row items-center gap-3 space-y-0 pr-8">
          <DialogTitle className="shrink-0">{t("project_extensions.skill_hub_title")}</DialogTitle>
          <div className="relative w-56 shrink-0">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-dls-secondary" />
            <input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={t("project_extensions.search_skills")}
              className="w-full rounded-lg border border-dls-border bg-dls-surface py-1.5 pl-8 pr-3 text-sm text-dls-text outline-none transition-colors placeholder:text-dls-secondary focus:border-dls-accent"
            />
          </div>
          <div className="flex items-center gap-1.5">
            {(["recommended", "skillhub", "installed"] as HubTab[]).map((key) => (
              <Button
                key={key}
                type="button"
                variant={tab === key ? "secondary" : "outline"}
                size="sm"
                onClick={() => setTab(key)}
              >
                {t(`project_extensions.tab_${key}`)}
              </Button>
            ))}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <p className="py-8 text-center text-sm text-destructive">{error}</p>
          ) : visibleItems.length === 0 && !loading ? (
            <p className="py-8 text-center text-sm text-dls-secondary">
              {t("project_extensions.no_skills_found")}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {visibleItems.map((skill) => {
                const installed = isInstalled(skill);
                const checked = installed || selected.has(skillKey(skill));
                return (
                  <button
                    type="button"
                    key={skillKey(skill)}
                    onClick={() => toggleSelect(skill)}
                    disabled={installed}
                    className={cn(
                      "relative flex gap-3 rounded-xl border p-3 text-left transition-colors",
                      checked ? "border-green-9 bg-green-2/40" : "border-dls-border hover:border-dls-border-hover",
                      installed ? "cursor-default opacity-80" : "cursor-pointer",
                    )}
                  >
                    <SkillAvatar name={skill.displayName} sizeClass="size-9" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-dls-text">{skill.displayName}</p>
                      {skill.summary ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-dls-secondary">{skill.summary}</p>
                      ) : null}
                    </div>
                    {checked ? (
                      <CheckCircle2 className="absolute right-2 top-2 size-4 text-green-9" />
                    ) : null}
                    {installed ? (
                      <span className="absolute bottom-2 right-2 rounded-full bg-dls-bg px-1.5 py-0.5 text-[10px] text-dls-secondary">
                        {t("ext_card.installed")}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
          {loading ? (
            <div className="flex items-center justify-center py-4 text-dls-secondary">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : null}
          {!loading && hasMore && tab !== "installed" ? (
            <div className="flex justify-center py-3">
              <Button variant="outline" size="sm" onClick={() => void runSearch(page + 1, true)}>
                {t("project_extensions.load_more")}
              </Button>
            </div>
          ) : null}
        </div>

        {installError ? (
          <p className="whitespace-pre-wrap text-xs text-destructive">{installError}</p>
        ) : null}
        <div className="flex items-center justify-between border-t border-dls-border pt-3">
          <span className="text-sm text-dls-secondary">
            {t("project_extensions.selected_count", { count: selectedCount })}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={installing}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleConfirm()} disabled={installing || selectedCount === 0}>
              {installing ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("common.confirm")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
