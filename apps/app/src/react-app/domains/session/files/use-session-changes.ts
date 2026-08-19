import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { unwrap, type createClient } from "@/app/lib/opencode";

type OpencodeClient = ReturnType<typeof createClient>;

/**
 * 会话改动中的一个文件
 *
 * @param path 工作区相对路径
 * @param status 变更状态
 * @param additions 新增行数
 * @param deletions 删除行数
 * @param patch unified diff 文本，可能为空（如二进制文件）
 */
export type SessionChange = {
  path: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  patch: string;
};

type ChangeAccumulator = {
  additions: number;
  deletions: number;
  patches: string[];
  firstStatus: SessionChange["status"];
  lastStatus: SessionChange["status"];
};

function changesQueryKey(sessionId: string) {
  return ["session-changes", sessionId] as const;
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function resolveStatus(entry: ChangeAccumulator): SessionChange["status"] {
  if (entry.lastStatus === "deleted") return "deleted";
  if (entry.firstStatus === "added") return "added";

  return "modified";
}

/**
 * 汇总当前会话累计产生的文件改动
 *
 * TIPS: 引擎的 `GET /session/:id/diff` 不传 messageID 时**恒定返回空数组** ——
 * 它只负责查单条用户消息的 diff。会话累计改动只能从消息列表里取：每条用户消息的
 * `summary.diffs` 是那一轮（step-start 快照 → step-finish 快照）的改动，这里按文件
 * 把各轮合并。各轮 patch 的行号分属不同快照，因此按轮次顺序拼接而不是强行合并。
 *
 * @param client 引擎客户端
 * @param sessionId 会话 id
 * @param workspaceRoot 工作区根目录绝对路径
 */
async function fetchSessionChanges(
  client: OpencodeClient,
  sessionId: string,
  workspaceRoot: string,
): Promise<SessionChange[]> {
  const messages = unwrap(
    await client.session.messages({ sessionID: sessionId, directory: workspaceRoot || undefined }),
  );
  const byPath = new Map<string, ChangeAccumulator>();

  for (const message of messages) {
    if (message.info.role !== "user") continue;

    for (const diff of message.info.summary?.diffs ?? []) {
      if (!diff.file) continue;

      const path = normalizePath(diff.file);
      const status = diff.status ?? "modified";
      const existing = byPath.get(path);

      if (!existing) {
        byPath.set(path, {
          additions: diff.additions ?? 0,
          deletions: diff.deletions ?? 0,
          patches: diff.patch ? [diff.patch] : [],
          firstStatus: status,
          lastStatus: status,
        });

        continue;
      }

      existing.additions += diff.additions ?? 0;
      existing.deletions += diff.deletions ?? 0;
      existing.lastStatus = status;

      if (diff.patch) existing.patches.push(diff.patch);
    }
  }

  return [...byPath.entries()]
    .map(([path, entry]) => ({
      path,
      status: resolveStatus(entry),
      additions: entry.additions,
      deletions: entry.deletions,
      patch: entry.patches.join("\n"),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * 订阅当前会话累计产生的文件改动
 *
 * TIPS: 会话从执行中转为空闲时说明本轮改动已落盘，此时才失效重取，
 * 避免执行过程中反复拉取整份消息列表。
 *
 * @param client 引擎客户端，未就绪时传 null
 * @param sessionId 会话 id
 * @param workspaceRoot 工作区根目录绝对路径
 * @param busy 会话是否正在执行
 */
export function useSessionChanges(
  client: OpencodeClient | null,
  sessionId: string | null,
  workspaceRoot: string,
  busy: boolean,
) {
  const queryClient = useQueryClient();
  const previousBusyRef = React.useRef(busy);

  const query = useQuery<SessionChange[]>({
    queryKey: changesQueryKey(sessionId ?? ""),
    queryFn: () => fetchSessionChanges(client!, sessionId!, workspaceRoot),
    enabled: Boolean(client && sessionId),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  React.useEffect(() => {
    const wasBusy = previousBusyRef.current;

    previousBusyRef.current = busy;

    if (wasBusy && !busy && sessionId) {
      void queryClient.invalidateQueries({ queryKey: changesQueryKey(sessionId) });
    }
  }, [busy, queryClient, sessionId]);

  return query;
}
