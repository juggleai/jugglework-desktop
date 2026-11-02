# Windows Media Tools

Windows x64 and ARM64 use the existing authenticated FFmpeg 7.1.5 archive and
fixed VideoLAN x264 commit/tree/archive. No downstream FFmpeg binaries are used.
Git source archival explicitly sets core.autocrlf=false and tar.umask=0002 so
Windows generates exactly the locked source archive, rather than changing its hash.

The portable llvm-mingw 20261020 UCRT x86_64 host archive is pinned by the
publisher GitHub asset SHA-256 in scripts/mediaToolsWindowsToolchain.json.
Git MSYS bash supplies POSIX configure tools; Windows bsdtar handles xz and
llvm-mingw's bundled make performs builds. No administrator privilege or reboot
was needed. Both targets disable assembly, autodetection, network, shared
libraries and nonfree, enabling GPL and static x264/FFmpeg/compiler runtime.

Resources contain the exact application sources, license texts, build recipe,
compiler/configuration records and separate build/post-sign inventories. MinGW
runtime and LLVM runtime notices accompany statically linked compiler support.
PE machine checks distinguish x64 and ARM64; a bounded PE32+ import parser rejects
foreign DLLs, delay/bound imports and CLR payloads. No target fallback is allowed.

electron-builder 26.15.3 signs extraResources before afterPack. Validate the built
source bundle first, require every non-executable byte and the original manifest
to remain unchanged, validate both media Authenticode signatures, then record
post-sign inventory before the final app/installer signing. Never re-sign pinned
Bun or change its trusted hash. Packaged runtime requires valid Authenticode with
the same certificate as the running application. Child media processes have empty
PATH and a host-owned working directory, not the project directory.

Measured 2026-10-30: both source-built targets passed PE/import/inventory checks.
x64 actual smoke passed probe, trim, extraction, separation, analysis, mixed
audio/silent export, full decode and authorization/tamper/cancellation checks.
20 focused tests: 16 pass, four platform-specific skips, zero failures. ARM64 was
cross-built and statically checked only; no ARM64 runtime/installation claim.
Local self-signing is not public production trust and has no trusted timestamp.
macOS behavior is unchanged; Linux remains unsupported. Detailed immutable
publication evidence belongs in ignored release-staging/1.2.32/release-report.md.
