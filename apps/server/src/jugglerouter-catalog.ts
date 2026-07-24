import { externalFetch } from "./server-fetch.js";

export const JUGGLEROUTER_CATALOG_URL = "https://jugglerouter.com/api/pricing";

export type JuggleRouterCatalogModel = {
  id: string;
  tags: string[];
};

type CatalogFetch = (input: string, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function parseJuggleRouterCatalog(payload: unknown): JuggleRouterCatalogModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];

  const seen = new Set<string>();
  const models: JuggleRouterCatalogModel[] = [];
  for (const entry of payload.data) {
    if (!isRecord(entry) || typeof entry.model_name !== "string") continue;
    const id = entry.model_name.trim();
    const tags = stringList(entry.tags);
    const endpointTypes = stringList(entry.supported_endpoint_types);
    if (!id || seen.has(id) || !tags.includes("chat") || !endpointTypes.includes("openai")) {
      continue;
    }
    seen.add(id);
    models.push({ id, tags });
  }
  return models;
}

export async function fetchJuggleRouterCatalog(
  fetchCatalog: CatalogFetch = externalFetch,
): Promise<JuggleRouterCatalogModel[]> {
  const response = await fetchCatalog(JUGGLEROUTER_CATALOG_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`JuggleRouter catalog returned HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  return parseJuggleRouterCatalog(payload);
}
