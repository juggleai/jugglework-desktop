import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const index = process.argv.indexOf('--outdir');
const output = index < 0 ? join(root, 'resources/helpers') : resolve(process.argv[index + 1]);
const requested = process.env.TARGET ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? process.arch;
const arch = /^(arm64|aarch64)/.test(requested) ? 'arm64' : 'x86_64';
mkdirSync(output, { recursive: true });
const executable = join(output, 'MeetingWindowTracker');
for (const [command, args] of [
  ['xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macosx14.0`, join(root, 'native/MeetingWindowTracker.swift'), '-o', executable]],
  ['codesign', ['--force', '--sign', '-', executable]],
]) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
