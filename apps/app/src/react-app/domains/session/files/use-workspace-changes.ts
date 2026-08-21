import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { unwrap, type createClient } from "@/app/lib/opencode";
import { subscribeWorkspaceFileChanges } from "../sync/session-sync";

type OpencodeClient = ReturnType<typeof createClient>;

/**
 * 工作区里的一个变更文件
 *
 * @param path 工作区相对路径
 * @param status 变更状态
 * @param additions 新增行数
 * @param deletions 删除行数
 * @param patch unified diff 文本，可能为空（如二进制文件）
 */
export type WorkspaceChange = {
  path: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  patch: string;
};

/**
 * 工作区改动的查询结果
 *
 * @param vcsAvailable 工作区是否有可用的 git（未安装 git 或不是 git 仓库时为 false）
 * @param changes 未提交的改动，vcsAvailable 为 false 时恒为空
 */
export type WorkspaceChangesResult = {
  vcsAvailable: boolean;
  changes: WorkspaceChange[];
};

/** 引擎事件触发重取前的合并窗口，一次批量改动只重取一次 */
const EVENT_DEBOUNCE_MS = 250;

function changesQueryKey(workspaceRoot: string) {
  return ["workspace-changes", workspaceRoot] as const;
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * 查询工作区是否有可用的 git
 *
 * TIPS: 引擎对"没装 git"和"不是 git 仓库"给的是同一个信号——`GET /vcs` 返回
 * `{branch: null}`，而不是报错，所以这里只看有没有 branch。
 *
 * @param client 引擎客户端
 * @param workspaceRoot 工作区根目录绝对路径
 */
async function probeVcsAvailable(client: OpencodeClient, workspaceRoot: string): Promise<boolean> {
  const info = unwrap(await client.vcs.get({ directory: workspaceRoot || undefined }));

  return Boolean(info.branch);
}

/**
 * 拉取工作区当前未提交的改动
 *
 * TIPS: 用引擎的 `GET /vcs/diff?mode=git`（git 工作区 diff），而不是会话消息里的
 * `summary.diffs`。后者只是每一轮 agent 改了什么的回放，你在编辑器、终端或别的
 * 会话里改的文件永远不会出现在里面。vcs 接口按 git 口径算，未跟踪文件也计入。
 *
 * TIPS: 空列表有两种含义——干净的 git 仓库，或者根本没有 git。只在空列表时补一次
 * `GET /vcs` 把两者分开，有改动的常见路径仍然只发一个请求。`/vcs/diff` 抛错时同样
 * 用它兜底：确认 git 可用才把错误抛出去，避免把"没装 git"报成加载失败。
 *
 * @param client 引擎客户端
 * @param workspaceRoot 工作区根目录绝对路径
 */
async function fetchWorkspaceChanges(
  client: OpencodeClient,
  workspaceRoot: string,
): Promise<WorkspaceChangesResult> {
  let diffs;

  try {
    diffs = unwrap(await client.vcs.diff({ directory: workspaceRoot || undefined, mode: "git" }));
  } catch (error) {
    if (await probeVcsAvailable(client, workspaceRoot)) throw error;

    return { vcsAvailable: false, changes: [] };
  }

  const changes = diffs
    .map((diff) => ({
      path: normalizePath(diff.file),
      status: diff.status ?? "modified",
      additions: diff.additions ?? 0,
      deletions: diff.deletions ?? 0,
      patch: diff.patch ?? "",
    }))
    // 增删都为 0 的文件（如仅改了权限位）不算改动，不进列表也不进标签计数
    .filter((change) => change.additions > 0 || change.deletions > 0)
    .sort((left, right) => left.path.localeCompare(right.path));

  if (changes.length > 0) return { vcsAvailable: true, changes };

  return { vcsAvailable: await probeVcsAvailable(client, workspaceRoot), changes };
}

/**
 * 订阅工作区当前未提交的改动
 *
 * TIPS: 不轮询。重取时机有三处——引擎推送的改动事件（`session.diff` / `file.edited`
 * / `file.watcher.updated`，经 session-sync 的事件流转发）、会话从执行中转为空闲、
 * 以及窗口重新获得焦点。最后一条覆盖"在外部编辑器改完切回来"：引擎的文件监听在
 * 桌面端默认不推事件，只靠事件会漏。
 *
 * @param client 引擎客户端，未就绪时传 null
 * @param workspaceId 运行时工作区 id，用于订阅引擎事件
 * @param workspaceRoot 工作区根目录绝对路径
 * @param busy 会话是否正在执行
 */
export function useWorkspaceChanges(
  client: OpencodeClient | null,
  workspaceId: string | null,
  workspaceRoot: string,
  busy: boolean,
) {
  const queryClient = useQueryClient();
  const previousBusyRef = React.useRef(busy);

  const query = useQuery<WorkspaceChangesResult>({
    queryKey: changesQueryKey(workspaceRoot),
    queryFn: () => fetchWorkspaceChanges(client!, workspaceRoot),
    enabled: Boolean(client),
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });

  const invalidate = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: changesQueryKey(workspaceRoot) });
  }, [queryClient, workspaceRoot]);

  React.useEffect(() => {
    const wasBusy = previousBusyRef.current;

    previousBusyRef.current = busy;

    if (wasBusy && !busy) invalidate();
  }, [busy, invalidate]);

  React.useEffect(() => {
    if (!workspaceId) return;

    let timer: number | null = null;
    const schedule = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        invalidate();
      }, EVENT_DEBOUNCE_MS);
    };

    const unsubscribe = subscribeWorkspaceFileChanges(workspaceId, schedule);

    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [invalidate, workspaceId]);

  return query;
}

/**
 * 手动重取工作区改动，用于「变更」面板上的刷新按钮
 *
 * @param workspaceRoot 工作区根目录绝对路径
 */
export function useRefreshWorkspaceChanges(workspaceRoot: string) {
  const queryClient = useQueryClient();

  return React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: changesQueryKey(workspaceRoot) });
  }, [queryClient, workspaceRoot]);
}
