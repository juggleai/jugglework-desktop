## 1. Default origin

- [x] 1.1 Update renderer and main-process defaults, keep legacy compatibility and add a focused regression test.
- [x] 1.2 Run focused tests and validate the OpenSpec change.

## 2. Distribution

- [x] 2.1 Build and verify a macOS arm64 DMG with version 1.2.14, recording signing and notarization status.
- [x] 2.2 Upload the verified DMG without overwrite to juggleim/jugglework/releases/v1.2.14/mac/arm64/ and verify remote size/hash.

## 3. Distribution evidence (2026-09-08)

- Local artifact: `apps/desktop/dist-electron-jugglechat-cn/jugglework-mac-arm64-1.2.14.dmg`
- Bundle version/build: `1.2.14` / `1.2.14`; executable and packaged native modules are arm64
- Embedded defaults: renderer and Electron main process both contain `https://work.jugglechat.cn`; `/jwork/api/v1/me/desktop-config` resolves on that origin and returns the expected unauthenticated `401`
- DMG integrity: `hdiutil verify` passed; packaged native SQLite/PTY and bundled UI-control MCP smoke checks passed
- SHA-256: `69434fe5642f25e11f16fc6c5696d5573738e43ac26bc11d85a439e285aa2d2b`
- Size: `241437984` bytes
- Qiniu ETag: `llWTURjwBw7yZMcjV1c-b_CkSWqs`
- Signing: deep/strict verification passed for `Developer ID Application: Beijing Qiyilu Technology Co., Ltd (H7PDHSK3C7)`
- Notarization: not performed (`mac.notarize: false`); Gatekeeper reports `Unnotarized Developer ID`
- Remote object: `juggleim/jugglework/releases/v1.2.14/mac/arm64/jugglework-mac-arm64-1.2.14.dmg`
- Upload policy: remote preflight returned not found; upload used `qshell fput` without `--overwrite`; post-upload remote size and ETag exactly match local values
