function encodeFilePath(path: string) {
  return path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

export function toFileUrl(path: string) {
  const normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${encodeFilePath(normalized).replace(/^([A-Za-z])%3A/, "$1:")}`;
  return `file://${encodeFilePath(normalized)}`;
}

export function joinWorkspaceRelativePath(workspaceRoot: string, relativePath: string) {
  const root = workspaceRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const relative = relativePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!root || !relative) return "";
  return `${root}/${relative}`;
}
