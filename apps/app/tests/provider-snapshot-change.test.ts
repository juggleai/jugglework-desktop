import { describe, expect, test } from "bun:test";
import type { Client } from "../src/app/types";
import { fetchProviderList, getConnectedProviderSnapshotChange, stableSnapshotValue } from "../src/react-app/infra/provider-list-query";

// 使用非托管 provider id，避免被托管范围过滤；比较逻辑与 lpr_* 相同。
const provider = (models: Record<string, unknown>) => ({ all: [{ id: "plain_x", name: "X", source: "config", env: [], npm: "", models }], connected: ["plain_x"], default: {} });
const model = (extra: Record<string, unknown> = {}) => ({ id: "m", name: "M", cost: { input: 1, output: 2 }, limit: { context: 1000, output: 100 }, variants: { high: { a: 1, b: 2 } }, ...extra });

async function refresh(first: unknown, second: unknown) {
  let value: unknown = first;
  const client = { provider: { list: async () => ({ data: value, request: new Request("https://x.test"), response: new Response(null) }) } } as unknown as Client;
  const input = { client, baseUrl: `https://snapshot.test/${crypto.randomUUID()}`, directory: "/p" };
  await fetchProviderList(input);
  value = second;
  await fetchProviderList(input);
  return getConnectedProviderSnapshotChange(input)!;
}

describe("connected provider snapshot change", () => {
  test("identical lists are not a change", async () => {
    expect((await refresh(provider({ m: model() }), provider({ m: model() }))).changed).toBe(false);
  });

  test("same models with different key order are not a change", async () => {
    const reordered = { limit: { output: 100, context: 1000 }, cost: { output: 2, input: 1 }, variants: { high: { b: 2, a: 1 } }, name: "M", id: "m" };
    expect((await refresh(provider({ m: model() }), provider({ m: reordered }))).changed).toBe(false);
  });

  test("an undefined field is not a change", async () => {
    expect((await refresh(provider({ m: model() }), provider({ m: model({ extra: undefined }) }))).changed).toBe(false);
  });

  test("a real value change is still reported", async () => {
    expect((await refresh(provider({ m: model() }), provider({ m: model({ cost: { input: 9, output: 2 } }) }))).changed).toBe(true);
  });

  test("a new model is still reported", async () => {
    expect((await refresh(provider({ m: model() }), provider({ m: model(), n: model({ id: "n" }) }))).changed).toBe(true);
  });

  test("array order stays significant", () => {
    expect(JSON.stringify(stableSnapshotValue({ a: [1, 2] }))).not.toBe(JSON.stringify(stableSnapshotValue({ a: [2, 1] })));
  });
});
