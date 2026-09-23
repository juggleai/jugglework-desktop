export const DEFAULT_CLOUD_URL = "https://work.jugglechat.cn";

export type CloudUrls = {
  origin: string;
  controlPlaneUrl: string;
  apiBaseUrl: string;
  catalogUrl: string;
};

const SUPPORTED_PATHS = new Set(["", "/", "/jwork", "/jwork/api", "/api/den"]);

export function normalizeCloudUrl(input: string | null | undefined): CloudUrls {
  const value = input?.trim() || DEFAULT_CLOUD_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Cloud URL must be an absolute HTTPS URL.");
  }
  if (url.username || url.password) throw new Error("Cloud URL must not contain credentials.");
  if (url.search || url.hash) throw new Error("Cloud URL must not contain a query or fragment.");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Cloud URL must use HTTPS (HTTP is allowed only for loopback development).");
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (!SUPPORTED_PATHS.has(path)) {
    throw new Error("Cloud URL path must be the origin, /jwork, /jwork/api, or /api/den.");
  }
  const origin = url.origin;
  return {
    origin,
    controlPlaneUrl: `${origin}/jwork`,
    apiBaseUrl: path === "/api/den" ? `${origin}/api/den` : `${origin}/jwork/api`,
    catalogUrl: `${origin}/jwork/models/api.json`,
  };
}
