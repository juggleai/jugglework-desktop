import { useQuery, useQueryClient } from "@tanstack/react-query";

import { unwrap, type createClient } from "@/app/lib/opencode";

type OpencodeClient = ReturnType<typeof createClient>;

/** 单层目录最多渲染的条目数，超出部分截断并提示 */
export const MAX_TREE_ENTRIES_PER_DIR = 500;

/**
 * 目录树中的一个条目
 *
 * @param name 条目名称
 * @param path 工作区相对路径
 * @param type 条目类型
 * @param ignored 是否被 .gitignore 等规则忽略（仅用于弱化展示，不做过滤）
 */
export type WorkspaceTreeEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  ignored: boolean;
};

/**
 * 单层目录的列举结果
 *
 * @param entries 目录条目，目录在前、名称升序
 * @param truncated 是否因超过上限而截断
 * @param total 截断前的条目总数
 */
export type WorkspaceTreeListing = {
  entries: WorkspaceTreeEntry[];
  truncated: boolean;
  total: number;
};

/** 根目录在查询 key 与展开集合中的表示 */
export const WORKSPACE_TREE_ROOT = "";

function sortEntries(entries: WorkspaceTreeEntry[]): WorkspaceTreeEntry[] {
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;

    return left.name.localeCompare(right.name);
  });
}

/**
 * 归一化引擎返回的条目路径
 *
 * TIPS: 引擎给目录条目的 path 带尾部斜杠（`sub/`），直接拿去做展开集合的 key
 * 或文件标签 id 会和其它来源的同一路径对不上，这里统一去掉。
 *
 * @param path 引擎返回的路径
 * @param parentPath 父目录的工作区相对路径
 * @param name 条目名称
 */
function normalizeEntryPath(path: string, parentPath: string, name: string): string {
  const cleaned = path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  if (cleaned) return cleaned;

  return parentPath ? `${parentPath}/${name}` : name;
}

/**
 * 列举工作区某一层目录
 *
 * TIPS: 引擎的 `/file` 只返回一层，正好用于懒加载；服务端的 catalog 快照接口是
 * 整仓递归且不跳过 .git / node_modules，大仓上会长时间阻塞，故不使用。
 *
 * @param client 引擎客户端
 * @param directory 工作区根目录绝对路径
 * @param path 目标目录的工作区相对路径，根目录传空串
 */
export async function listWorkspaceDir(
  client: OpencodeClient,
  directory: string,
  path: string,
): Promise<WorkspaceTreeListing> {
  const nodes = unwrap(await client.file.list({ path: path || ".", directory: directory || undefined }));
  const entries = sortEntries(
    nodes.map((node) => ({
      name: node.name,
      path: normalizeEntryPath(node.path, path, node.name),
      type: node.type,
      ignored: node.ignored === true,
    })),
  );

  return {
    entries: entries.slice(0, MAX_TREE_ENTRIES_PER_DIR),
    truncated: entries.length > MAX_TREE_ENTRIES_PER_DIR,
    total: entries.length,
  };
}

function treeQueryKey(workspaceRoot: string, path: string) {
  return ["workspace-tree", workspaceRoot, path] as const;
}

/**
 * 订阅某一层目录的内容
 *
 * @param client 引擎客户端，未就绪时传 null
 * @param workspaceRoot 工作区根目录绝对路径
 * @param path 目标目录的工作区相对路径
 * @param enabled 是否发起请求（目录折叠时为 false）
 */
export function useWorkspaceDir(
  client: OpencodeClient | null,
  workspaceRoot: string,
  path: string,
  enabled: boolean,
) {
  return useQuery<WorkspaceTreeListing>({
    queryKey: treeQueryKey(workspaceRoot, path),
    queryFn: () => listWorkspaceDir(client!, workspaceRoot, path),
    enabled: Boolean(client) && enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * 使工作区目录树的全部缓存失效，用于手动刷新
 *
 * @param workspaceRoot 工作区根目录绝对路径
 */
export function useRefreshWorkspaceTree(workspaceRoot: string) {
  const queryClient = useQueryClient();

  return () => {
    void queryClient.invalidateQueries({ queryKey: ["workspace-tree", workspaceRoot] });
  };
}
