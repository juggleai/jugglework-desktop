import { z } from "zod";

const id = z.string().trim().min(1).max(256);

/**
 * The signed-in identity a user turn was sent under. Native actions run only
 * for this exact deployment, account and organization; the renderer refuses a
 * request whose live identity no longer matches it.
 */
export const nativeActionScopeSchema = z.object({
  baseUrl: z.string().trim().min(1).max(2048),
  userId: id,
  organizationId: id,
}).strict();

export type NativeActionScope = z.infer<typeof nativeActionScopeSchema>;
