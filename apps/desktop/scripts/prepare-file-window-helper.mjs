import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") process.exit(0);
const argument = process.argv.indexOf("--outdir");
const out =
  argument >= 0
    ? resolve(process.argv[argument + 1])
    : join(root, "resources/helpers");
const bundle = join(out, "JuggleWork File Browser.app");
const resources = join(bundle, "Contents/Resources");
const executable = join(bundle, "Contents/MacOS/DocumentDock");
const iconset = join(out, "file-window.iconset");

/** 执行本机构建工具，失败时阻断打包，避免缺少 Dock 图标的产物。 */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`);
}
mkdirSync(dirname(executable), { recursive: true });
mkdirSync(resources, { recursive: true });
mkdirSync(iconset, { recursive: true });
const requested = process.env.TARGET ?? process.env.TAURI_ENV_TARGET_TRIPLE;
const arch = requested?.startsWith("x86_64")
  ? "x86_64"
  : requested?.startsWith("aarch64")
    ? "arm64"
    : process.arch === "arm64"
      ? "arm64"
      : "x86_64";
run("xcrun", [
  "swiftc",
  "-O",
  "-target",
  `${arch}-apple-macosx14.0`,
  join(root, "native/FileWindowDock.swift"),
  "-o",
  executable,
]);
const icon = resolve(root, "../app/public/file-window-logo.png");
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    run("sips", [
      "-z",
      String(size * scale),
      String(size * scale),
      icon,
      "--out",
      join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
    ]);
  }
}
run("iconutil", ["-c", "icns", iconset, "-o", join(resources, "AppIcon.icns")]);
rmSync(iconset, { recursive: true, force: true });
writeFileSync(
  join(bundle, "Contents/Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>DocumentDock</string>
<key>CFBundleIdentifier</key><string>com.juggleai.jugglework.documents</string>
<key>CFBundleName</key><string>JuggleWork 文件浏览器</string>
<key>CFBundleDisplayName</key><string>JuggleWork 文件浏览器</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
</dict></plist>`,
);
run("codesign", ["--force", "--sign", "-", bundle]);
console.log(JSON.stringify({ ok: true, bundle, arch }));
