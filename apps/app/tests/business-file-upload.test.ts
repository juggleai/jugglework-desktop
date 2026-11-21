import { afterEach, expect, mock, test } from "bun:test";
import { uploadBusinessFile } from "../src/app/lib/business-file-upload";
import { createDenClient } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;
const grant = {
  provider: "qiniu" as const, uploadUrl: "https://up-z2.qiniup.com", token: "upload-only",
  key: "objects/123", fileUrl: "https://cdn.example/objects/123", expiresAt: "2099-01-01T00:00:00Z",
};
const file = new File(["bytes"], "图.png", { type: "image/png" });
const options = { file, purpose: "task_image" as const, taskId: "task-1", organizationId: "org/a" };
function replaceFetch(fn: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fn });
}
afterEach(() => replaceFetch(originalFetch));

test("only the credential POST uses Den identity; Qiniu receives multipart and the same signal", async () => {
  const signal = new AbortController().signal;
  const requests: string[] = [];
  replaceFetch(async (url, init) => {
    requests.push(String(url));
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBe(signal);
    const headers = new Headers(init?.headers);
    if (requests.length === 1) {
      expect(headers.get("Authorization")).toBe("Bearer den-session");
      expect(headers.get("x-jugglework-legacy-org-id")).toBe("org/a");
      expect(JSON.parse(String(init?.body))).toEqual({
        purpose: "task_image", fileName: file.name, contentType: file.type, sizeBytes: 5, taskId: "task-1",
      });
      return Response.json(grant);
    }
    expect([...headers]).toEqual([]);
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
    const form = init?.body as FormData;
    expect([...form.keys()]).toEqual(["token", "key", "file"]);
    expect(form.get("token")).toBe(grant.token);
    expect(form.get("key")).toBe(grant.key);
    expect(await (form.get("file") as File).text()).toBe("bytes");
    return Response.json({ key: grant.key, url: "https://ignored.example" });
  });
  const client = createDenClient({ baseUrl: "https://den.test", token: "den-session" });
  expect(await uploadBusinessFile({ ...options, client, signal })).toEqual({ name: file.name, url: grant.fileUrl });
  expect(requests).toEqual(["https://den.test/jwork/api/v1/organizations/org%2Fa/file-upload-credentials", grant.uploadUrl + "/"]);
});

test("file limits are inclusive and checked before requesting credentials", async () => {
  const client = { createFileUploadCredentials: mock(async () => grant) };
  replaceFetch(async () => Response.json({ key: grant.key }));
  for (const [purpose, type, mib] of [["avatar", "image/jpeg", 5], ["task_image", "image/gif", 5], ["task_attachment", "application/pdf", 20]] as const) {
    const bytes = new Uint8Array(mib * 1024 * 1024);
    await uploadBusinessFile({ ...options, purpose, client, file: new File([bytes], "ok", { type }) });
    await expect(uploadBusinessFile({ ...options, purpose, client, file: new File([bytes, "!"], "big", { type }) })).rejects.toThrow("MiB");
  }
  for (const purpose of ["avatar", "task_image"] as const) {
    await expect(uploadBusinessFile({ ...options, purpose, client, file: new File(["data"], "fake.png", { type: "image/svg+xml" }) })).rejects.toThrow();
  }
  expect(client.createFileUploadCredentials).toHaveBeenCalledTimes(3);
});

test("arbitrary attachments keep their name and bytes without trusting the browser's MIME type", async () => {
  const client = { createFileUploadCredentials: mock(async () => grant) };
  replaceFetch(async (_url, init) => {
    const part = (init!.body as FormData).get("file") as File;
    expect(part.type).toBe("application/octet-stream");
    expect(await part.text()).toBe("data");
    return Response.json({ key: grant.key });
  });
  for (const [name, type] of [["README", ""], ["report.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], ["archive.zip", "application/zip"]]) {
    const result = await uploadBusinessFile({ ...options, client, purpose: "task_attachment", file: new File(["data"], name, { type }) });
    expect(client.createFileUploadCredentials).toHaveBeenLastCalledWith(options.organizationId, expect.objectContaining({ fileName: name, contentType: "application/octet-stream", sizeBytes: 4 }), expect.anything());
    expect(result.name).toBe(name);
  }
});

test("invalid grants never send the token or file", async () => {
  const post = mock(async () => Response.json({ key: grant.key }));
  replaceFetch(post);
  const invalid = [
    ...["http://up.qiniup.com", "https://up.qiniup.com.example", "https://up.qiniup.com@evil.example",
      "https://user@up.qiniup.com", "https://up.qiniup.com:8443", "https://bucket.qbox.me", "https://up.qiniup.com/other"].map(uploadUrl => ({ uploadUrl })),
    { fileUrl: "javascript:void(0)" }, { expiresAt: "invalid" }, { expiresAt: "2000-01-01" }, { key: "" }, { token: "" },
  ];
  for (const change of invalid) {
    const client = { createFileUploadCredentials: async () => ({ ...grant, ...change }) };
    await expect(uploadBusinessFile({ ...options, client })).rejects.toThrow("上传凭据");
  }
  expect(post).not.toHaveBeenCalled();
});

test("HTTP failure, unreadable receipt and key mismatch never release a URL", async () => {
  const client = { createFileUploadCredentials: async () => grant };
  for (const response of [new Response(null, { status: 403 }), new Response("OK"), Response.json({}), Response.json({ key: "other" })]) {
    replaceFetch(async () => response);
    await expect(uploadBusinessFile({ ...options, client })).rejects.toThrow();
  }
});

test("aborting while Den is issuing credentials prevents the storage POST", async () => {
  const controller = new AbortController();
  const post = mock(async () => Response.json({}));
  replaceFetch(post);
  const client = { createFileUploadCredentials: async () => { controller.abort(); return grant; } };
  await expect(uploadBusinessFile({ ...options, client, signal: controller.signal })).rejects.toThrow();
  expect(post).not.toHaveBeenCalled();
});
