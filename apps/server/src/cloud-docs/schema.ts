import { z } from "zod";

const id = z.string().min(1).max(256);
const ref = z.object({
  tenantId: id,
  workspaceId: id,
  docId: id,
  title: z.string().max(300),
  blockIds: z.array(id).max(200).optional(),
}).strict();

/** 消息边界只接收引用定位和面板激活标签，不接收云文档正文或 hash。 */
export const cloudDocTurnSchema = z.object({
  currentTenantId: id.nullable(),
  references: z.array(ref).max(32),
  activeDoc: ref.nullable().optional(),
}).strict();
