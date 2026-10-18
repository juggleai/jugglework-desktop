/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { Folder, FolderOpen, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";

import type { ToonFactoryProject } from "@/app/lib/desktop-types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type ToonFactorySidebarRegistration = {
  projects: ToonFactoryProject[];
  currentDirectory: string | null;
  busy: boolean;
  onOpenProject: (directory: string) => void;
  onRenameProject: (directory: string, name: string) => Promise<boolean>;
  onRevealProject: (directory: string) => Promise<void>;
  onRemoveProject: (directory: string) => Promise<boolean>;
  onRequestCreate: () => void;
};

function projectFolderName(project: ToonFactoryProject) {
  return project.directory.split(/[\\/]/).filter(Boolean).at(-1) || project.name;
}

export function ToonFactoryProjectSidebar(props: ToonFactorySidebarRegistration & { preview?: boolean }) {
  const [query, setQuery] = useState("");
  const [searchVisible, setSearchVisible] = useState(false);
  const [renameProject, setRenameProject] = useState<ToonFactoryProject | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [removeProject, setRemoveProject] = useState<ToonFactoryProject | null>(null);
  const normalized = query.trim().toLocaleLowerCase();
  const projects = useMemo(() => [...props.projects]
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
    .filter(project => !normalized || `${project.name} ${project.directory}`.toLocaleLowerCase().includes(normalized)),
  [normalized, props.projects]);

  return (
    <aside
      className={cn(
        "flex h-full w-full flex-col overflow-hidden bg-[var(--app-secondary-sidebar-bg)] mac:titlebar-drag",
        props.preview && "rounded-[18px] border border-dls-border shadow-[0_18px_48px_rgba(15,23,42,0.18)] dark:shadow-[0_18px_48px_rgba(0,0,0,0.42)]",
      )}
      data-testid={props.preview ? "toon-factory-sidebar-preview" : "toon-factory-sidebar"}
    >
      <div className="flex h-[var(--app-topbar-height)] shrink-0 items-center gap-2 px-4 mac:titlebar-no-drag">
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">漫剧工厂</h1>
        <button
          type="button"
          title="搜索项目"
          aria-label="搜索项目"
          aria-expanded={searchVisible}
          onClick={() => setSearchVisible(value => !value)}
          className={cn("rounded-lg p-2 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text", searchVisible && "bg-dls-hover text-dls-text")}
        >
          <Search className="size-4" />
        </button>
      </div>
      <div className="space-y-2 px-3 pb-3 mac:titlebar-no-drag">
        {searchVisible ? (
          <label className="relative block">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-dls-secondary" />
            <input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索漫剧项目" className="h-9 w-full rounded-xl bg-dls-hover pl-9 pr-3 text-[13px] outline-none" />
          </label>
        ) : null}
        <button type="button" disabled={props.busy} onClick={props.onRequestCreate} className="flex h-9 w-full items-center gap-2 rounded-xl px-2 text-left text-[13px] font-medium transition-colors hover:bg-dls-hover disabled:opacity-50">
          <Plus className="size-4" />新建项目
        </button>
      </div>
      <div className="mx-4 shrink-0 border-t border-dls-border" />
      <div className="flex min-h-0 flex-1 flex-col pt-3 mac:titlebar-no-drag">
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {!props.projects.length ? <p className="px-2 py-2 text-[13px] text-dls-secondary">暂无漫剧项目</p> : null}
          {props.projects.length > 0 && !projects.length ? <p className="px-2 py-2 text-[13px] text-dls-secondary">没有匹配的项目</p> : null}
          <div className="space-y-0.5">
            {projects.map(project => (
              <div
                key={project.directory}
                className={cn(
                  "group/project relative flex h-10 w-full items-center overflow-hidden rounded-xl transition-colors hover:bg-dls-hover/60 has-[:focus-visible]:bg-dls-hover/60",
                  project.directory === props.currentDirectory && "bg-dls-active",
                )}
              >
                <button
                  type="button"
                  disabled={props.busy}
                  aria-current={project.directory === props.currentDirectory ? "page" : undefined}
                  onClick={() => props.onOpenProject(project.directory)}
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2.5 pr-9 text-left disabled:opacity-50"
                >
                  <span className="flex size-5 shrink-0 items-center justify-center text-dls-text"><Folder className="size-4.5" strokeWidth={1.8} /></span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-normal text-dls-text" title={project.name || projectFolderName(project)}>{project.name || projectFolderName(project)}</span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={props.busy}
                        className="absolute right-1.5 size-7 opacity-0 transition-opacity group-hover/project:opacity-100 group-has-[:focus-visible]/project:opacity-100 data-popup-open:opacity-100"
                        onClick={event => event.stopPropagation()}
                        aria-label={`项目选项：${project.name || projectFolderName(project)}`}
                      >
                        <MoreHorizontal className="size-4" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" side="bottom" sideOffset={4} className="w-52">
                    <DropdownMenuItem onClick={() => { setRenameProject(project); setRenameDraft(project.name || projectFolderName(project)); }}>
                      <Pencil className="size-4" />编辑名称
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => { void props.onRevealProject(project.directory); }}>
                      <FolderOpen className="size-4" />在 Finder 中显示
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => setRemoveProject(project)}>
                      <Trash2 className="size-4" />移除项目
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
          </div>
        </div>
      </div>
      <Dialog open={Boolean(renameProject)} onOpenChange={open => { if (!open && !props.busy) setRenameProject(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑项目名称</DialogTitle>
            <DialogDescription>只修改漫剧工厂中的显示名称，不会重命名项目文件夹。</DialogDescription>
          </DialogHeader>
          <input
            autoFocus
            value={renameDraft}
            maxLength={120}
            onChange={event => setRenameDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key !== "Enter" || !renameProject || !renameDraft.trim()) return;
              event.preventDefault();
              void props.onRenameProject(renameProject.directory, renameDraft).then(ok => { if (ok) setRenameProject(null); });
            }}
            className="h-10 w-full rounded-xl border border-dls-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            aria-label="项目名称"
          />
          <DialogFooter>
            <Button variant="ghost" disabled={props.busy} onClick={() => setRenameProject(null)}>取消</Button>
            <Button disabled={props.busy || !renameDraft.trim()} onClick={() => {
              if (!renameProject) return;
              void props.onRenameProject(renameProject.directory, renameDraft).then(ok => { if (ok) setRenameProject(null); });
            }}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(removeProject)} onOpenChange={open => { if (!open && !props.busy) setRemoveProject(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移除项目</DialogTitle>
            <DialogDescription>只会从漫剧工厂项目列表中移除“{removeProject?.name || (removeProject ? projectFolderName(removeProject) : "")}”，不会删除文件夹或其中的任何文件。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={props.busy} onClick={() => setRemoveProject(null)}>取消</Button>
            <Button variant="destructive" disabled={props.busy} onClick={() => {
              if (!removeProject) return;
              void props.onRemoveProject(removeProject.directory).then(ok => { if (ok) setRemoveProject(null); });
            }}>移除项目</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

export function ToonFactoryProjectDialog(props: {
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onChooseFolder: () => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={open => { if (!props.busy) props.onOpenChange(open); }}>
      <DialogContent data-toon-factory-project-dialog>
        <DialogHeader>
          <DialogTitle>新建或导入漫剧项目</DialogTitle>
          <DialogDescription>选择一个文件夹。如果其中已有漫剧项目文件，将直接导入；如果没有，将在该文件夹中新建项目。</DialogDescription>
        </DialogHeader>
        <div className="rounded-2xl border border-dashed border-dls-border bg-dls-sidebar/50 px-4 py-5 text-sm text-dls-secondary">
          项目画布和素材会保存在你选择的文件夹中。
        </div>
        <DialogFooter>
          <Button disabled={props.busy} onClick={props.onChooseFolder}>
            <Folder className="size-4" />{props.busy ? "正在打开…" : "选择文件夹"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
