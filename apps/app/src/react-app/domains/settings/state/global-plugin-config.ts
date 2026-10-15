import { applyEdits, modify } from "jsonc-parser";

import { parsePluginListFromContent, stripPluginVersion } from "@/app/utils/plugins";
import {
  readGlobalOpencodeConfig,
  writeGlobalOpencodeConfig,
  type GlobalConfigTarget,
} from "@/react-app/domains/settings/state/global-opencode-config";

function samePlugin(left: string, right: string) {
  return stripPluginVersion(left).toLowerCase() === stripPluginVersion(right).toLowerCase();
}

/** Remove one plugin spec from JSONC while retaining unrelated settings and comments. */
export function removeGlobalPluginFromConfig(raw: string, spec: string): string {
  const plugins = parsePluginListFromContent(raw);
  const next = plugins.filter((entry) => !samePlugin(entry, spec));
  if (next.length === plugins.length) throw new Error("Plugin is not present in the global configuration.");
  const source = raw.trim() ? raw : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const edits = modify(source, ["plugin"], next, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  return applyEdits(source, edits);
}

/** Remove one configured global OpenCode plugin without touching directory-discovered plugins. */
export async function removeGlobalPlugin(target: GlobalConfigTarget, spec: string): Promise<void> {
  const raw = await readGlobalOpencodeConfig(target);
  if (raw == null) throw new Error("Global plugin configuration is unavailable in this runtime.");
  await writeGlobalOpencodeConfig(target, removeGlobalPluginFromConfig(raw, spec));
}
