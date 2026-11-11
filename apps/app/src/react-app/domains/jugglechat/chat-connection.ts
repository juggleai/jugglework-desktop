import {
  denCredentialFingerprint,
  readDenIMLoginBootstrap,
  readDenSettings,
  readDenUserId,
} from "@/app/lib/den";
import type { ChatConnectionScope } from "./docs-message";

/** 固定完整部署前缀、源用户、组织与凭据代次；同 App／同 IM 用户仍是不同连接范围。 */
export function readChatConnectionScope(): ChatConnectionScope | null {
  const settings = readDenSettings(),
    im = readDenIMLoginBootstrap(),
    userId = readDenUserId();
  if (!settings.authToken || !settings.activeOrgId || !userId || !im)
    return null;
  let server: string;
  try {
    server = new URL(settings.baseUrl).href.replace(/\/+$/, "");
  } catch {
    return null;
  }
  const authFingerprint = denCredentialFingerprint(settings.authToken);
  return Object.freeze({
    server,
    userId,
    tenantId: settings.activeOrgId,
    authFingerprint,
    imUserId: im.imUserId,
    key: [
      server,
      userId,
      settings.activeOrgId,
      authFingerprint,
      im.appKey,
      im.websocketUrl,
      im.imUserId,
      denCredentialFingerprint(im.token),
    ].join("\0"),
  });
}
