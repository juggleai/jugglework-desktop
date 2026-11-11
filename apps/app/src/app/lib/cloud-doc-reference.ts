/** 云文档引用只保存稳定定位与块选区，不保存正文或 hash。 */
export type CloudDocReference = {
  tenantId: string;
  workspaceId: string;
  docId: string;
  title: string;
  blockIds?: string[];
};

export const CLOUD_DOC_TOKEN_RE = /\[cloud-doc ([^\]\s]+)\]/g;

/** 将引用编码为随草稿保存的原子标签。 */
export function cloudDocToken(ref: CloudDocReference): string {
  return `[cloud-doc ${encodeURIComponent(JSON.stringify(ref))}]`;
}

/** 解析引用标签，拒绝携带正文、无效标识及超量选区的数据。 */
export function parseCloudDocToken(token: string): CloudDocReference | null {
  const match = /^\[cloud-doc ([^\]\s]+)\]$/.exec(token);
  if (!match) return null;
  try {
    const ref = JSON.parse(decodeURIComponent(match[1]));
    if (!ref || typeof ref !== "object" || Object.keys(ref).some(key => !["tenantId", "workspaceId", "docId", "title", "blockIds"].includes(key))) return null;
    if (![ref.tenantId, ref.workspaceId, ref.docId].every(id => typeof id === "string" && id.length > 0 && id.length <= 256)) return null;
    if (typeof ref.title !== "string" || ref.title.length > 300) return null;
    if (ref.blockIds !== undefined && (!Array.isArray(ref.blockIds) || ref.blockIds.length > 200 || !ref.blockIds.every((id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 256))) return null;
    return { tenantId: ref.tenantId, workspaceId: ref.workspaceId, docId: ref.docId, title: ref.title, ...(ref.blockIds?.length ? { blockIds: [...new Set<string>(ref.blockIds)] } : {}) };
  } catch { return null; }
}

/** 同一组织同一文档的整篇优先于选区，多个选区取并集。 */
export function mergeCloudDocReferences(refs: CloudDocReference[], next: CloudDocReference): CloudDocReference[] {
  const index = refs.findIndex(ref => ref.tenantId === next.tenantId && ref.workspaceId === next.workspaceId && ref.docId === next.docId);
  if (index < 0 && refs.length >= 32) throw new Error("cloud_docs.reference_limit");
  const prior = refs[index];
  const blockIds = prior && (!prior.blockIds?.length || !next.blockIds?.length) ? undefined : [...new Set([...(prior?.blockIds ?? []), ...(next.blockIds ?? [])])];
  if (blockIds && blockIds.length > 200) throw new Error("cloud_docs.selection_limit");
  const merged = { ...next, blockIds: blockIds?.length ? blockIds : undefined };
  return index < 0 ? [...refs, merged] : refs.map((ref, i) => i === index ? merged : ref);
}

/** 发送时只从实际草稿标签取引用，删除的标签和其他会话不会进入本轮范围。 */
export function cloudDocReferences(text: string): CloudDocReference[] {
  let refs: CloudDocReference[] = [];
  for (const match of text.matchAll(CLOUD_DOC_TOKEN_RE)) {
    const ref = parseCloudDocToken(match[0]);
    if (ref) refs = mergeCloudDocReferences(refs, ref);
  }
  return refs;
}
