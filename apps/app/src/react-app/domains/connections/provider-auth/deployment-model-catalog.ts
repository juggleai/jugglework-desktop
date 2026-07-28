import { getDenModelCatalogUrl } from "../../../../app/lib/den";

/**
 * The connected deployment's provider catalog, in the models.dev payload shape
 * (`<providerId>` -> `<modelId>` -> model metadata).
 *
 * Org-published providers land in the workspace under their cloud row id
 * (`lpr_*`), and the engine matches catalog entries by config key — so an
 * imported provider never picks the catalog up on its own and every model
 * would fall back to `context: 0`, `cost: 0` and text-only capabilities.
 * Importing resolves the catalog by the provider's *source* id instead and
 * writes the metadata into the block (#2346 follow-up).
 */
export type DeploymentCatalogModel = Record<string, unknown>;
export type DeploymentModelCatalog = Record<string, Record<string, DeploymentCatalogModel>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function parseDeploymentModelCatalog(payload: unknown): DeploymentModelCatalog {
  if (!isRecord(payload)) return {};
  return Object.fromEntries(
    Object.entries(payload).flatMap(([providerId, provider]) => {
      if (!isRecord(provider) || !isRecord(provider.models)) return [];
      const models = Object.fromEntries(
        Object.entries(provider.models).flatMap(([modelId, model]) =>
          isRecord(model) ? [[modelId, model] as const] : [],
        ),
      );
      return Object.keys(models).length > 0 ? [[providerId, models] as const] : [];
    }),
  );
}

/**
 * The catalog is a few hundred KB and changes only when an operator ships a new
 * server build, so hold it briefly: long enough that importing several
 * providers in a row costs one fetch, short enough that a redeployed catalog
 * lands without restarting the app.
 */
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Importing waits on this fetch, and cloud sync imports on startup — so an
 * unreachable deployment must fail fast rather than stall every provider.
 */
const CATALOG_FETCH_TIMEOUT_MS = 10_000;

const catalogCache = new Map<
  string,
  { request: Promise<DeploymentModelCatalog | null>; loadedAt: number }
>();

/**
 * Fetch the deployment catalog, or null when there is none to fetch (hosted
 * cloud) or it cannot be read. The catalog is metadata enrichment, never a
 * precondition: a failed fetch is not cached, so the next import retries.
 */
export async function loadDeploymentModelCatalog(
  baseUrl?: string | null,
): Promise<DeploymentModelCatalog | null> {
  const url = getDenModelCatalogUrl(baseUrl);
  if (!url) return null;

  const cached = catalogCache.get(url);
  if (cached && Date.now() - cached.loadedAt < CATALOG_CACHE_TTL_MS) {
    return await cached.request;
  }

  const request = (async () => {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      // The deployment serves the catalog as `Cache-Control: public,
      // max-age=300`, so the HTTP cache will happily hand back the payload
      // from before an operator redeployed a fix. The TTL above already keeps
      // repeated imports to one request — go to the network for that one.
      cache: "no-store",
      signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return parseDeploymentModelCatalog(await response.json());
  })().catch(() => null);

  catalogCache.set(url, { request, loadedAt: Date.now() });
  const catalog = await request;
  if (!catalog) catalogCache.delete(url);
  return catalog;
}
