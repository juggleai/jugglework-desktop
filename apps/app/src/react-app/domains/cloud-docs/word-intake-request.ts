// TIPS: v2 使用无损基础段落初始化；显式重试不能复用旧 Markdown 转换结果。
const storageKey = "jugglework-cloud-docs-word-intake-v2";

export type WordIntakeRequest = {
  requestId: string;
  tenantId: string;
  sourceServerOrigin: string;
  sourceUserId: string;
  documentId: string;
  localWorkspaceId: string;
  relativePath: string;
  savedFileSha256: string;
  title: string;
  createdAt: number;
};

/** 保存一次从 Office Word 进入当前组织云文档的宿主请求，不保存正文或登录令牌。 */
export function saveWordIntakeRequest(input: Omit<WordIntakeRequest, "requestId" | "createdAt">) {
  try {
    const prior = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (
      prior?.tenantId === input.tenantId &&
      prior?.sourceServerOrigin === input.sourceServerOrigin &&
      prior?.sourceUserId === input.sourceUserId &&
      prior?.documentId === input.documentId &&
      prior?.localWorkspaceId === input.localWorkspaceId &&
      prior?.relativePath === input.relativePath &&
      prior?.savedFileSha256 === input.savedFileSha256 &&
      /^[a-f0-9-]{36}$/i.test(prior.requestId ?? "") &&
      Number.isSafeInteger(prior.createdAt) &&
      Date.now() - prior.createdAt <= 10 * 60 * 1000
    ) {
      const value = { ...prior, title: input.title } as WordIntakeRequest;
      sessionStorage.setItem(storageKey, JSON.stringify(value));
      return value;
    }
  } catch {
    // 损坏的旧请求由下面的新请求覆盖。
  }
  const value: WordIntakeRequest = {
    ...input,
    requestId: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  sessionStorage.setItem(storageKey, JSON.stringify(value));
  return value;
}

/** 读取当前组织仍有效的 Word 接入请求。 */
export function readWordIntakeRequest(tenantId: string): WordIntakeRequest | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (
      !value ||
      value.tenantId !== tenantId ||
      !/^[a-f0-9-]{36}$/i.test(value.requestId) ||
      typeof value.documentId !== "string" ||
      typeof value.localWorkspaceId !== "string" ||
      typeof value.relativePath !== "string" ||
      !/^[a-f0-9]{64}$/i.test(value.savedFileSha256 ?? "") ||
      typeof value.title !== "string" ||
      !Number.isSafeInteger(value.createdAt) ||
      Date.now() - value.createdAt > 10 * 60 * 1000
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

/** 只清理本次已经处理的请求，不能删除后来创建的新请求。 */
export function clearWordIntakeRequest(requestId: string) {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (value?.requestId === requestId) sessionStorage.removeItem(storageKey);
  } catch {
    sessionStorage.removeItem(storageKey);
  }
}
