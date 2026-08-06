/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, FileText, Folder, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { desktopBridge } from "@/app/lib/desktop";
import type { SkillFileEntry } from "@/app/lib/desktop-types";
import { t } from "@/i18n";
import type { SkillItem } from "../mcp-view";
import { MarkdownBlock } from "../../../session/surface/markdown";
import { SkillAvatar } from "./skill-avatar";

type DetailTab = "overview" | "files";

// 去掉 SKILL.md 顶部的 YAML frontmatter，只保留正文用于 markdown 渲染。
function stripFrontmatter(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("---")) return trimmed;
  const rest = trimmed.slice(3);
  const end = rest.indexOf("\n---");
  if (end === -1) return trimmed;
  return rest.slice(end + 4).replace(/^\s*\n?/, "");
}

// 从 SKILL.md 文件路径推导技能目录（跨平台，兼容 / 与 \）。
function dirnameOf(filePath: string): string {
  return filePath.replace(/[/\\][^/\\]*$/, "");
}

// 字节数格式化为可读大小。
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type TreeNode = {
  name: string;
  isDir: boolean;
  size: number;
  children: TreeNode[];
};

// 由扁平文件列表构建目录树，目录在前、同层按名排序。
function buildTree(files: SkillFileEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", isDir: true, size: 0, children: [] };
  for (const file of files) {
    const parts = file.relPath.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const isLeaf = index === parts.length - 1;
      let child = node.children.find((c) => c.name === part && c.isDir === !isLeaf);
      if (!child) {
        child = { name: part, isDir: !isLeaf, size: isLeaf ? file.size : 0, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sortNode = (node: TreeNode) => {
    node.children.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    node.children.forEach(sortNode);
  };
  sortNode(root);
  return root.children;
}

function FileTreeNode({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(false);
  const paddingLeft = 8 + depth * 16;
  if (node.isDir) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm hover:bg-dls-bg"
          style={{ paddingLeft }}
        >
          <ChevronRight className={cn("size-3.5 shrink-0 text-dls-secondary transition-transform", open && "rotate-90")} />
          <Folder className="size-4 shrink-0 text-blue-9" />
          <span className="truncate text-dls-text">{node.name}</span>
        </button>
        {open ? (
          <div>
            {node.children.map((child) => (
              <FileTreeNode key={`${child.name}-${child.isDir}`} node={child} depth={depth + 1} />
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 py-1.5 pr-2 text-sm" style={{ paddingLeft: paddingLeft + 20 }}>
      <FileText className="size-4 shrink-0 text-dls-secondary" />
      <span className="min-w-0 flex-1 truncate text-dls-text">{node.name}</span>
      <span className="shrink-0 text-xs text-dls-secondary tabular-nums">{formatSize(node.size)}</span>
    </div>
  );
}

/**
 * 技能详情弹窗：展示概述与文件列表两个 tab。
 * @param open 是否打开
 * @param skill 目标技能
 * @param projectDir 项目根目录（读取 SKILL.md 用）
 * @param onClose 关闭回调
 */
export function SkillDetailModal({ open, skill, projectDir, onClose }: {
  open: boolean;
  skill: SkillItem | null;
  projectDir: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [content, setContent] = useState<string | null>(null);
  const [resolvedDir, setResolvedDir] = useState<string | null>(null);
  const [files, setFiles] = useState<SkillFileEntry[] | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);

  const isLocal = Boolean(skill && skill.origin !== "jugglework-connect");

  // 打开时重置到概述 tab 并清空缓存。
  useEffect(() => {
    if (open) setTab("overview");
    else {
      setContent(null);
      setResolvedDir(null);
      setFiles(null);
    }
  }, [open, skill?.name]);

  // 概述：读取 SKILL.md 正文，并由其真实路径推导技能目录（供文件 tab 使用）。
  useEffect(() => {
    if (!open || !skill || !isLocal) return;
    let cancelled = false;
    setLoadingContent(true);
    void desktopBridge
      .readLocalSkill(projectDir, skill.name)
      .then((r) => {
        if (cancelled) return;
        setContent(r?.content ?? "");
        if (r?.path) setResolvedDir(dirnameOf(r.path));
      })
      .catch(() => { if (!cancelled) setContent(""); })
      .finally(() => { if (!cancelled) setLoadingContent(false); });
    return () => { cancelled = true; };
  }, [open, skill, isLocal, projectDir]);

  // 文件 tab：用解析出的技能目录懒加载文件列表。
  useEffect(() => {
    if (!open || tab !== "files" || !isLocal || files) return;
    const dir = resolvedDir || skill?.path || "";
    if (!dir) return;
    let cancelled = false;
    setLoadingFiles(true);
    void desktopBridge
      .listSkillFiles(dir)
      .then((r) => { if (!cancelled) setFiles(r?.files ?? []); })
      .catch(() => { if (!cancelled) setFiles([]); })
      .finally(() => { if (!cancelled) setLoadingFiles(false); });
    return () => { cancelled = true; };
  }, [open, tab, isLocal, files, resolvedDir, skill?.path]);

  const tree = useMemo(() => (files ? buildTree(files) : []), [files]);

  if (!skill) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] max-w-[900px] flex-col sm:max-w-[900px]">
        <DialogHeader className="gap-3 pr-8">
          <div className="flex items-center gap-3">
            <SkillAvatar name={skill.name} sizeClass="size-10" />
            <div className="min-w-0">
              <DialogTitle className="truncate text-lg">{skill.name}</DialogTitle>
              {skill.scope === "global" ? (
                <span className="mt-0.5 inline-block rounded-full bg-dls-bg px-1.5 py-0.5 text-[10px] text-dls-secondary">
                  {t("project_extensions.scope_global")}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-1.5 border-b border-dls-border">
            {(["overview", "files"] as DetailTab[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={cn(
                  "-mb-px border-b-2 px-2 pb-2 text-sm transition-colors",
                  tab === key
                    ? "border-dls-text font-medium text-dls-text"
                    : "border-transparent text-dls-secondary hover:text-dls-text",
                )}
              >
                {t(`project_extensions.detail_tab_${key}`)}
              </button>
            ))}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "overview" ? (
            <div className="space-y-3">
              {!isLocal ? (
                <>
                  {skill.description ? (
                    <p className="text-sm leading-relaxed text-dls-text">{skill.description}</p>
                  ) : null}
                  <p className="text-sm text-dls-secondary">{t("project_extensions.detail_connect_only")}</p>
                </>
              ) : loadingContent ? (
                <div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin text-dls-secondary" /></div>
              ) : content ? (
                <MarkdownBlock text={stripFrontmatter(content)} />
              ) : skill.description ? (
                <p className="text-sm leading-relaxed text-dls-text">{skill.description}</p>
              ) : null}
            </div>
          ) : (
            <div>
              {!isLocal ? (
                <p className="py-6 text-center text-sm text-dls-secondary">{t("project_extensions.detail_connect_only")}</p>
              ) : loadingFiles ? (
                <div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin text-dls-secondary" /></div>
              ) : (
                <div className="rounded-xl border border-dls-border">
                  <div className="border-b border-dls-border px-3 py-2 text-xs text-dls-secondary">
                    {t("project_extensions.detail_file_count", { count: files?.length ?? 0 })}
                  </div>
                  <div className="py-1">
                    {tree.map((node) => (
                      <FileTreeNode key={`${node.name}-${node.isDir}`} node={node} depth={0} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-dls-border pt-3">
          <Button variant="outline" onClick={onClose}>{t("common.close")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
