import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Parse imports without executing the target (also used for cross-built ARM64).
export function windowsMediaImports(file) {
  const b = readFileSync(file);
  const fail = () => { throw new Error("Invalid media PE/import table"); };
  if (b.length < 64 || b.toString("ascii", 0, 2) !== "MZ") fail();
  const pe = b.readUInt32LE(60);
  if (pe + 264 > b.length || b.toString("binary", pe, pe + 4) !== "PE\0\0") fail();
  const optional = pe + 24, size = b.readUInt16LE(pe + 20), count = b.readUInt16LE(pe + 6);
  if (b.readUInt16LE(optional) !== 0x20b || size < 240 || count > 96 || optional + size + count * 40 > b.length) fail();
  const offset = (rva, length) => {
    for (let i = 0; i < count; i++) {
      const s = optional + size + i * 40, va = b.readUInt32LE(s + 12), raw = b.readUInt32LE(s + 16);
      if (rva >= va && rva - va + length <= raw) {
        const o = b.readUInt32LE(s + 20) + rva - va;
        if (o + length <= b.length) return o;
      }
    }
    fail();
  };
  // No delay-load, bound imports or CLR payload in this minimal recipe.
  for (const index of [11, 13, 14]) if (b.readUInt32LE(optional + 112 + index * 8) || b.readUInt32LE(optional + 116 + index * 8)) fail();
  const rva = b.readUInt32LE(optional + 120), bytes = b.readUInt32LE(optional + 124);
  if (!rva || bytes < 40 || bytes > 65536) fail();
  const start = offset(rva, bytes), imports = [];
  for (let i = 0; i + 20 <= bytes; i += 20) {
    const descriptor = b.subarray(start + i, start + i + 20);
    if (descriptor.every(byte => byte === 0)) {
      if (!imports.length) fail();
      return imports;
    }
    const name = offset(descriptor.readUInt32LE(12), 1);
    const end = b.indexOf(0, name);
    if (end < name || end - name > 128) fail();
    const dll = b.toString("ascii", name, end).toLowerCase();
    if (!/^(kernel32|shell32|bcrypt|ucrtbase)\.dll$/.test(dll) && !/^api-ms-win-crt-(stdio|runtime|environment|string|locale|time|convert|math|heap|private|utility|filesystem|conio)-l1-1-0\.dll$/.test(dll)) throw new Error(`Non-system media import: ${dll}`);
    imports.push(dll);
  }
  fail();
}

export function windowsMediaSignature(file) {
  const powershell = `${process.env.SystemRoot || "C:/Windows"}/System32/WindowsPowerShell/v1.0/powershell.exe`;
  const literal = file.replaceAll("'", "''");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath '${literal}'; if ($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate) { throw 'Invalid media Authenticode signature' }; $s.SignerCertificate.Thumbprint`], { encoding: "utf8", timeout: 30000, windowsHide: true });
  if (result.error || result.status !== 0 || !/^[A-F0-9]{40}$/.test(result.stdout.trim())) throw new Error(`Media Authenticode verification failed: ${file}`);
  return result.stdout.trim();
}
