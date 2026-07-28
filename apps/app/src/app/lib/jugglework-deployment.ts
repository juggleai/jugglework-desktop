export const JUGGLEWORK_DEPLOYMENT_ENV_VAR = "VITE_JUGGLEWORK_DEPLOYMENT";

export type JuggleWorkDeployment = "desktop" | "web";

function normalizeDeployment(value: string | undefined): JuggleWorkDeployment {
  const normalized = value?.trim().toLowerCase();
  return normalized === "web" ? "web" : "desktop";
}

export function getJuggleWorkDeployment(): JuggleWorkDeployment {
  const envValue =
    typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_JUGGLEWORK_DEPLOYMENT === "string"
      ? import.meta.env.VITE_JUGGLEWORK_DEPLOYMENT
      : undefined;

  return normalizeDeployment(envValue);
}

export function isWebDeployment(): boolean {
  return getJuggleWorkDeployment() === "web";
}

export function isDesktopDeployment(): boolean {
  return getJuggleWorkDeployment() === "desktop";
}
