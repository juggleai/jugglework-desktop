import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import electron from "electron";

const root = await mkdtemp(join(tmpdir(), "jugglework-selection-page-"));
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 默认图片页回归自行生成 fixture；可选真实附件仅复制到隔离目录后打开。
const args = process.argv.slice(2);
const wordFile = args.find((arg) => arg.startsWith("--word-soft-break-file="));
const fileArg = wordFile ?? args.find((arg) => arg.startsWith("--slide-picture-page-file="));
const source = fileArg?.slice(fileArg.indexOf("=") + 1);
const fingerprint = async (path) => ({ sha256: createHash("sha256").update(await readFile(path)).digest("hex"), mtimeMs: (await stat(path)).mtimeMs });
let original;
try {
  if (fileArg) {
    assert.ok(source && (wordFile || args.includes("--slide-picture-page")), "附件参数必须与对应验收模式一起使用");
    original = await fingerprint(source);
    const copy = join(root, wordFile ? "attachment-copy.docx" : "attachment-copy.pptx");
    await copyFile(source, copy);
    args.splice(args.indexOf(fileArg), 1, wordFile ? `--word-soft-break-input=${copy}` : `--slide-picture-page-input=${copy}`);
  }
  const child = spawn(electron, [join(desktop, "scripts/verify-office-selection-worker.mjs"), root, ...args], {
    cwd: desktop, stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)); });
  clearTimeout(timer); process.exitCode = Number(code);
} finally {
  try {
    if (original) {
      assert.deepEqual(await fingerprint(source), original, "原附件必须保持不变");
      if (!wordFile) assert.equal((await fingerprint(join(root, "attachment-copy.pptx"))).sha256, original.sha256, "隔离副本不得保存修改");
      console.log(JSON.stringify({ attachmentUnchanged: true, ...(wordFile ? {} : { copyUnchanged: true }), sha256: original.sha256 }));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}
