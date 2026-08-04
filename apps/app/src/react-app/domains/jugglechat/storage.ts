import { readDenIMLoginBootstrap, readDenSettings } from "@/app/lib/den";

import type { ServerSetting } from "./types";

/**
 * Chat connection settings are part of the unified JuggleWork session.
 * AppKey, websocket URL, and IM token normally come from sign-in/account (or
 * the desktop handoff exchange). Source development can override the complete
 * IM bootstrap through the VITE_DEN_DEV_IM_* variables.
 */
export function getServerSetting(): ServerSetting | null {
  const im = readDenIMLoginBootstrap();
  if (!im) return null;
  const apiBaseUrl = readDenSettings().baseUrl;
  return {
    app_key: im.appKey,
    app_servers: [apiBaseUrl],
    im_servers: [im.websocketUrl],
    api_base_url: apiBaseUrl,
  };
}
