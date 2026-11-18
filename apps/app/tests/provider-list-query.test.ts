import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import type { Client } from "../src/app/types";
import {
  cloudGroupCatalogKey,
  usePickerProviderItems,
  ensureProviderListQuery,
  PROVIDER_LIST_CACHE_MS,
  providerListQueryKey,
} from "../src/react-app/infra/provider-list-query";

const empty: ProviderListResponse = { all: [], connected: [], default: {} };
const recovered: ProviderListResponse = {
  all: [{ id: "restored", name: "Restored", source: "api", env: [], npm: "", models: {} }],
  connected: ["restored"],
  default: {},
};

describe("ensureProviderListQuery", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    queryClient.clear();
  });

  function createBackend(directory: string) {
    let result: ProviderListResponse | Promise<ProviderListResponse> | Error = empty;
    const request = new Request("https://provider-list.test/provider");
    const list = mock(async () => {
      if (result instanceof Error) {
        return { error: result, request, response: new Response(null, { status: 503 }) };
      }
      return { data: await result, request, response: new Response(null) };
    });
    const input = {
      client: { provider: { list } } as unknown as Client,
      baseUrl: "https://provider-list.test",
      directory,
    };
    return {
      input,
      key: providerListQueryKey(input),
      list,
      setResult(value: typeof result) { result = value; },
    };
  }

  test("waits for a recovered backend when the cached empty list is stale", async () => {
    const backend = createBackend("/stale");
    await expect(ensureProviderListQuery(queryClient, backend.input)).resolves.toEqual(empty);
    queryClient.setQueryData(backend.key, empty, {
      updatedAt: Date.now() - PROVIDER_LIST_CACHE_MS - 1,
    });

    let resolveFetch!: (value: ProviderListResponse) => void;
    backend.setResult(new Promise<ProviderListResponse>((resolve) => { resolveFetch = resolve; }));
    let settled = false;
    const pending = ensureProviderListQuery(queryClient, backend.input).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(backend.list).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);

    resolveFetch(recovered);
    await expect(pending).resolves.toEqual(recovered);
    expect(queryClient.getQueryData(backend.key)).toEqual(recovered);
  });

  test("reuses a fresh cached empty list", async () => {
    const backend = createBackend("/fresh");
    await ensureProviderListQuery(queryClient, backend.input);
    backend.setResult(recovered);

    await expect(ensureProviderListQuery(queryClient, backend.input)).resolves.toEqual(empty);
    expect(backend.list).toHaveBeenCalledTimes(1);
  });

  test("force fetches a recovered backend even when the cached empty list is fresh", async () => {
    const backend = createBackend("/force");
    await ensureProviderListQuery(queryClient, backend.input);
    backend.setResult(recovered);

    await expect(ensureProviderListQuery(queryClient, { ...backend.input, force: true }))
      .resolves.toEqual(recovered);
    expect(backend.list).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(backend.key)).toEqual(recovered);
  });

  test.each(["missing", "stale"] as const)("rejects backend errors with %s cache instead of returning an empty list", async (cache) => {
    const backend = createBackend(`/error-${cache}`);
    const updatedAt = Date.now() - PROVIDER_LIST_CACHE_MS - 1;
    if (cache === "stale") {
      queryClient.setQueryData(backend.key, empty, { updatedAt });
    }
    backend.setResult(new Error("backend unavailable"));

    await expect(ensureProviderListQuery(queryClient, backend.input)).rejects.toThrow("backend unavailable");
    expect(backend.list).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(backend.key)).toEqual(cache === "stale" ? empty : undefined);
    expect(queryClient.getQueryState(backend.key)?.status).toBe("error");
    expect(queryClient.getQueryState(backend.key)?.dataUpdatedAt).toBe(cache === "stale" ? updatedAt : 0);
  });
});

test("open model pickers update from a confirmed cloud catalog while the raw engine list stays stale", async () => {
  const client = new QueryClient();
  const ids = ["lpr_relay", "lpr_codex", "my-local-provider"];
  const raw = {
    all: ids.map((id) => ({ ...recovered.all[0]!, id })),
    connected: ids,
    default: {},
  };
  let visible: string[] = [];
  function Picker() {
    visible = usePickerProviderItems(raw).map((provider) => provider.id);
    return null;
  }
  const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      view = create(createElement(QueryClientProvider, { client }, createElement(Picker)));
    });
    expect(visible).toEqual(ids);
    for (const enabled of [["lpr_codex"], [], ["lpr_relay"]]) {
      await act(async () => {
        client.setQueryData(cloudGroupCatalogKey(), enabled);
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      expect(visible).toEqual([...enabled, "my-local-provider"]);
    }
    expect(raw.all.map(({ id }) => id)).toEqual(ids);
  } finally {
    await act(async () => view?.unmount());
    client.clear();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
  }
});
