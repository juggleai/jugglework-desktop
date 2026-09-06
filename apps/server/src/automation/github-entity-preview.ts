import { ApiError } from "../errors.js";

/** 一次历史 PR/Issue 预览抓取的结果，形状对齐 `GithubEventDelivery` 里预览用得到的那几个字段。 */
export type GithubEntityPreview = {
  entityRef: string;
  entityUrl: string;
  untrustedText: Array<{ label: string; text: string }>;
};

const ENTITY_URL_PATTERN = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/(\d+)(?:[/?#].*)?$/;

/**
 * 解析一个 GitHub PR/Issue 的公开页面链接（任务 5.2 模拟测试的输入）。
 * TIPS: 只接受 `github.com` 上的公开页面形式——用户在浏览器地址栏能直接复制到的那种，
 * 不接受 API 直连地址或裸 `owner/repo#number`，没必要为一个预览功能另外教一种输入语法。
 */
export function parseGithubEntityUrl(url: string): { owner: string; repo: string; number: number } | null {
  const match = ENTITY_URL_PATTERN.exec(url.trim());
  if (!match) return null;
  const [, owner, repo, , numberText] = match;
  const number = Number(numberText);
  if (!Number.isFinite(number) || number <= 0) return null;
  return { owner, repo, number };
}

type GithubApiIssue = { title?: string; body?: string | null; html_url?: string; pull_request?: unknown };
type GithubApiComment = { body?: string | null };

/**
 * 拉取一个公开 GitHub PR/Issue 的标题/正文/最近评论，拼成跟真实投递同一形状的
 * `untrustedText`（见 event-pipeline.ts 的 `GithubEventDelivery`）——这样任务 5.2 的预览
 * 才能直接复用 `appendEventContextPromptParts` 组装最终 prompt，不用另写一套"预览专用"
 * 拼装逻辑，保证预览看到的和真实触发时组装的是同一段代码路径。
 *
 * TIPS: 只支持公开仓库——这里直接打 GitHub 公开 REST API，不经过 GitHub App 安装令牌
 * （那套凭据只在真实 run 的进程内短暂存活，见 executor.ts 的写回授权接线）。私有仓库对
 * 未认证请求一律表现成 404（GitHub 的既有行为：不暴露私有仓库是否存在），预览会在这一步
 * 就失败并提示，不是这个功能本身有 bug。
 */
export async function fetchGithubEntityPreview(
  target: { owner: string; repo: string; number: number },
  fetchImpl: typeof fetch = fetch,
): Promise<GithubEntityPreview> {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "jugglework-desktop-preview" };
  const issueUrl = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${target.number}`;
  const issueResponse = await fetchImpl(issueUrl, { headers });
  if (issueResponse.status === 404) {
    throw new ApiError(404, "github_entity_not_found", "This PR/issue could not be found — it may be private, or the link may be wrong.");
  }
  if (!issueResponse.ok) {
    throw new ApiError(502, "github_entity_fetch_failed", "GitHub did not return this PR/issue's content.");
  }
  const issue = (await issueResponse.json()) as GithubApiIssue;
  const isPullRequest = Boolean(issue.pull_request);

  // 评论抓取失败不该拖垮整个预览——标题/正文本身已经是有用的预览内容，降级展示即可。
  let comments: GithubApiComment[] = [];
  try {
    const commentsResponse = await fetchImpl(`${issueUrl}/comments?per_page=5&sort=created&direction=desc`, { headers });
    if (commentsResponse.ok) comments = (await commentsResponse.json()) as GithubApiComment[];
  } catch {
    comments = [];
  }

  const untrustedText: Array<{ label: string; text: string }> = [];
  if (issue.title) untrustedText.push({ label: "标题", text: issue.title });
  if (issue.body) untrustedText.push({ label: "正文", text: issue.body });
  // API 按创建时间倒序拿了最近 5 条，这里翻回正序展示，跟真实增量上下文（deltaSince）
  // "按实际发生顺序"的呈现习惯保持一致。
  comments
    .filter((comment): comment is GithubApiComment & { body: string } => Boolean(comment.body))
    .reverse()
    .forEach((comment, index) => untrustedText.push({ label: `评论 ${index + 1}`, text: comment.body }));

  return {
    entityRef: `github:${isPullRequest ? "pull_request" : "issue"}:${target.number}`,
    entityUrl: issue.html_url ?? `https://github.com/${target.owner}/${target.repo}/${isPullRequest ? "pull" : "issues"}/${target.number}`,
    untrustedText,
  };
}
