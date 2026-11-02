import { writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mediaInventory, verifyMediaTools, verifyMediaSignature } from "../electron/mediaTools.mjs";

// Media binaries deliberately live outside the upstream Bun inventory.
export function signMediaTools(options, target, { run = spawnSync, verify = verifyMediaTools, signature = verifyMediaSignature } = {}) {
  const root = path.join(options.app, "Contents/Resources/mediaTools");
  const tools = verify(root, target, { phase: "built" });
  if (!options.identity || options.identity === "-") throw new Error("[media-tools] Developer ID identity required for release signing");
  for (const name of ["ffmpeg", "ffprobe"]) {
    if (!options.ignore?.(tools[name])) throw new Error(`[media-tools] Default signer must exclude the explicitly signed ${name}`);
    const args = ["--force", "--options", "runtime", "--timestamp", "--sign", options.identity];
    if (options.keychain) args.push("--keychain", options.keychain);
    args.push(tools[name]);
    const result = run("/usr/bin/codesign", args, { stdio: "inherit" });
    if (result.error || result.status !== 0) throw new Error(`[media-tools] codesign failed: ${result.error?.message || result.status}`);
    signature(tools[name], "H7PDHSK3C7");
  }
  // Only executable bytes may change. Source, licenses, recipe and configuration
  // remain byte-for-byte the verified pre-sign inventory.
  const files = mediaInventory(root);
  const content = entries => entries.filter(entry => !["ffmpeg", "ffprobe"].includes(entry.path));
  if (JSON.stringify(content(files)) !== JSON.stringify(content(tools.manifest.files))) throw new Error("[media-tools] Non-executable resources changed while signing");
  const manifest = { ...tools.manifest, phase: "signed", signingTeam: "H7PDHSK3C7", files };
  writeFileSync(tools.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return () => verify(root, target, { phase: "signed", team: "H7PDHSK3C7" });
}
