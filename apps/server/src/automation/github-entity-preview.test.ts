import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../errors.js";
import { fetchGithubEntityPreview, parseGithubEntityUrl } from "./github-entity-preview.js";

test("parseGithubEntityUrl accepts issue and pull request page URLs, rejects everything else", () => {
  assert.deepEqual(parseGithubEntityUrl("https://github.com/juggleai/skillhub/issues/42"), { owner: "juggleai", repo: "skillhub", number: 42 });
  assert.deepEqual(parseGithubEntityUrl("https://github.com/juggleai/skillhub/pull/7"), { owner: "juggleai", repo: "skillhub", number: 7 });
  // 末尾带查询串/锚点/多余路径段也要能解析——用户从浏览器地址栏复制来的链接经常带这些。
  assert.deepEqual(parseGithubEntityUrl("https://github.com/juggleai/skillhub/pull/7?tab=files#discussion_r1"), { owner: "juggleai", repo: "skillhub", number: 7 });
  assert.deepEqual(parseGithubEntityUrl("  https://github.com/juggleai/skillhub/issues/42  "), { owner: "juggleai", repo: "skillhub", number: 42 });

  assert.equal(parseGithubEntityUrl("https://gitlab.com/juggleai/skillhub/issues/42"), null);
  assert.equal(parseGithubEntityUrl("https://api.github.com/repos/juggleai/skillhub/issues/42"), null);
  assert.equal(parseGithubEntityUrl("juggleai/skillhub#42"), null);
  assert.equal(parseGithubEntityUrl("https://github.com/juggleai/skillhub"), null);
  assert.equal(parseGithubEntityUrl(""), null);
});

function fakeFetch(responses: Record<string, { status: number; body?: unknown }>): typeof fetch {
  // 按 key 长度降序匹配——`.../issues/42` 是 `.../issues/42/comments` 的前缀，短 key 必须
  // 排在后面，否则两个 URL 都会先命中那个短 key。
  const keys = Object.keys(responses).sort((a, b) => b.length - a.length);
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const matchKey = keys.find((key) => url.startsWith(key));
    const response = matchKey ? responses[matchKey] : undefined;
    if (!response) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    } as Response;
  }) as typeof fetch;
}

const ISSUE_URL = "https://api.github.com/repos/juggleai/skillhub/issues/42";

test("fetchGithubEntityPreview assembles title/body/comments into untrustedText, oldest comment first", async () => {
  const fetchImpl = fakeFetch({
    [ISSUE_URL]: { status: 200, body: { title: "修复登录跳转", body: "点了登录按钮之后没反应", html_url: "https://github.com/juggleai/skillhub/issues/42" } },
    [`${ISSUE_URL}/comments`]: { status: 200, body: [{ body: "最新一条" }, { body: "更早一条" }] }, // GitHub 返回按创建时间倒序
  });
  const preview = await fetchGithubEntityPreview({ owner: "juggleai", repo: "skillhub", number: 42 }, fetchImpl);
  assert.equal(preview.entityRef, "github:issue:42");
  assert.equal(preview.entityUrl, "https://github.com/juggleai/skillhub/issues/42");
  assert.deepEqual(preview.untrustedText, [
    { label: "标题", text: "修复登录跳转" },
    { label: "正文", text: "点了登录按钮之后没反应" },
    { label: "评论 1", text: "更早一条" },
    { label: "评论 2", text: "最新一条" },
  ]);
});

test("fetchGithubEntityPreview recognizes a pull request via the pull_request field", async () => {
  const fetchImpl = fakeFetch({
    [ISSUE_URL]: { status: 200, body: { title: "加个开关", pull_request: { url: "..." } } },
    [`${ISSUE_URL}/comments`]: { status: 200, body: [] },
  });
  const preview = await fetchGithubEntityPreview({ owner: "juggleai", repo: "skillhub", number: 42 }, fetchImpl);
  assert.equal(preview.entityRef, "github:pull_request:42");
});

test("fetchGithubEntityPreview degrades gracefully when the comments fetch fails, keeping title/body", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === ISSUE_URL) return { ok: true, status: 200, json: async () => ({ title: "只有标题" }) } as Response;
    throw new Error("network down");
  }) as typeof fetch;
  const preview = await fetchGithubEntityPreview({ owner: "juggleai", repo: "skillhub", number: 42 }, fetchImpl);
  assert.deepEqual(preview.untrustedText, [{ label: "标题", text: "只有标题" }]);
});

test("fetchGithubEntityPreview surfaces a 404 as github_entity_not_found, distinct from other failures", async () => {
  const fetchImpl = fakeFetch({ [ISSUE_URL]: { status: 404 } });
  await assert.rejects(
    fetchGithubEntityPreview({ owner: "juggleai", repo: "skillhub", number: 42 }, fetchImpl),
    (error: unknown) => error instanceof ApiError && error.status === 404 && error.code === "github_entity_not_found",
  );
});

test("fetchGithubEntityPreview surfaces a non-404 failure as github_entity_fetch_failed", async () => {
  const fetchImpl = fakeFetch({ [ISSUE_URL]: { status: 500 } });
  await assert.rejects(
    fetchGithubEntityPreview({ owner: "juggleai", repo: "skillhub", number: 42 }, fetchImpl),
    (error: unknown) => error instanceof ApiError && error.status === 502 && error.code === "github_entity_fetch_failed",
  );
});
