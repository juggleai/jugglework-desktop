/** 文件在工作区中的稳定身份，历史交付快照与当前元信息分别维护。 */
export interface FileArtifact {
  artifactId: string;
  workspaceId: string;
  relativePath: string;
  name: string;
  kind: string;
  mimeType: string;
  sizeBytes: number | null;
  updatedAt: number | null;
  exists: boolean;
  editingOwner: "internal" | "external";
}

/** 真实用户消息及其执行批次的归属，不由模型指定历史轮次。 */
export interface ArtifactOrigin {
  sessionId: string;
  turnId: string;
  runId: string;
}

/** 每轮文件快照；旧消息补录时不虚构原始大小和保存时间。 */
export interface TurnArtifact {
  sessionId: string;
  turnId: string;
  artifactId: string;
  snapshot: {
    name: string;
    sizeBytes: number | null;
    updatedAt: number | null;
  };
  source: "runtime" | "history";
}

export type FileDeliveryStatus =
  "collecting" | "finalizing" | "ready" | "partial" | "failed";

/** 某次成功写入或后台任务对应的待确认目标，key 在重放时保持不变。 */
export interface FileDeliveryTarget {
  key: string;
  runId: string;
  path: string | null;
  source: "tool" | "generation" | "media" | "office";
  status: "pending" | "ready" | "failed";
  artifactId?: string;
  jobId?: string;
  documentId?: string;
  outputDirectory?: string;
  outputs?: string[];
  error?: string;
  retryable?: boolean;
}

/** 文件交付状态独立于模型运行状态，后台完成仍更新原始轮次。 */
export interface TurnDelivery {
  sessionId: string;
  turnId: string;
  runIds: string[];
  finishedRunIds: string[];
  status: FileDeliveryStatus;
  targets: FileDeliveryTarget[];
  items: TurnArtifact[];
}

/** 会话级批量查询响应，文件当前状态与各轮历史快照分离。 */
export interface SessionFileArtifacts {
  files: FileArtifact[];
  turns: TurnDelivery[];
}
