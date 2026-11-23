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
const denUrl = "https://den.test/jwork/api/v1/organizations/org%2Fa/file-upload-credentials";
const denClient = () => createDenClient({ baseUrl: "https://den.test", token: "den-session" });
type UploadCredentials = Awaited<ReturnType<ReturnType<typeof denClient>["createFileUploadCredentials"]>>;
const clientWithGrant = (value: unknown) => ({ createFileUploadCredentials: async () => value as UploadCredentials });
const imageRequest = { purpose: "task_image", fileName: file.name, contentType: file.type, sizeBytes: 5, taskId: "task-1" };
const legacyDecodeError = { error: "invalid_request", message: "Invalid storage request." };
const putGrant = {
  provider: "aws" as const, method: "PUT" as const, key: grant.key, expiresAt: grant.expiresAt,
  uploadUrl: "https://bucket.storage.test/objects/123?X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bif-none-match&X-Amz-Signature=fixture",
  headers: { "Content-Type": "image/png", "If-None-Match": "*" as const },
  fileUrl: "https://cdn.test/assets/objects/123",
};
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
      expect(JSON.parse(String(init?.body))).toEqual({ ...imageRequest, uploadProtocol: "put-v1" });
      return Response.json(grant);
    }
    expect([...headers]).toEqual([]);
    expect(init).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    const form = init?.body as FormData;
    expect([...form.keys()]).toEqual(["token", "key", "file"]);
    expect(form.get("token")).toBe(grant.token);
    expect(form.get("key")).toBe(grant.key);
    expect(await (form.get("file") as File).text()).toBe("bytes");
    return Response.json({ key: grant.key, url: "https://ignored.example" });
  });
  expect(await uploadBusinessFile({ ...options, client: denClient(), signal })).toEqual({ name: file.name, url: grant.fileUrl });
  expect(requests).toEqual([denUrl, grant.uploadUrl + "/"]);
});

test("the old strict decoder triggers one credential retry without put-v1, then legacy multipart", async () => {
  const signal = new AbortController().signal;
  const requests: string[] = [];
  replaceFetch(async (url, init) => {
    requests.push(String(url));
    expect(init?.signal).toBe(signal);
    expect(init?.method).toBe("POST");
    if (url === denUrl) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer den-session");
      expect(JSON.parse(String(init?.body))).toEqual(requests.length === 1 ? { ...imageRequest, uploadProtocol: "put-v1" } : imageRequest);
      return requests.length === 1 ? Response.json(legacyDecodeError, { status: 400 }) : Response.json(grant);
    }
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(init?.body).toBeInstanceOf(FormData);
    return Response.json({ key: grant.key });
  });
  expect(await uploadBusinessFile({ ...options, client: denClient(), signal })).toEqual({ name: file.name, url: grant.fileUrl });
  expect(requests).toEqual([denUrl, denUrl, grant.uploadUrl + "/"]);
});

test.each([
  [400, { error: "invalid_request", message: "The request is invalid." }],
  [400, { ...legacyDecodeError, details: { field: "fileName" } }],
  [400, { message: legacyDecodeError.message }],
  [403, legacyDecodeError],
  [503, { error: "storage_unavailable" }],
])("does not retry an unrelated credential error (HTTP %i, %j)", async (status, payload) => {
  const request = mock(async () => Response.json(payload, { status }));
  replaceFetch(request);
  await expect(uploadBusinessFile({ ...options, client: denClient() })).rejects.toMatchObject({ status });
  expect(request).toHaveBeenCalledTimes(1);
});

test("a second decoder rejection is propagated and a non-negotiated PUT grant is refused", async () => {
  for (const [retry, expectedStatus] of [
    [Response.json(legacyDecodeError, { status: 400 }), 400],
    [Response.json(putGrant), 502],
  ] as const) {
    const request = mock(async () => retry);
    request.mockImplementationOnce(async () => Response.json(legacyDecodeError, { status: 400 }));
    replaceFetch(request);
    await expect(uploadBusinessFile({ ...options, client: denClient() })).rejects.toMatchObject({ status: expectedStatus });
    expect(request).toHaveBeenCalledTimes(2);
  }
});

test.each([
  ["aws", putGrant.uploadUrl, "if-none-match", "*"],
  ["minio", "https://minio.test:9443/bucket/objects/123?X-Amz-Signature=fixture", "if-none-match", "*"],
  ["oss", "https://bucket.oss.test/objects/123?x-oss-signature=fixture", "x-oss-forbid-overwrite", "true"],
] as const)("%s PUT uses only renderer fetch and the approved raw bytes and headers", async (provider, uploadUrl, conditional, condition) => {
  const signal = new AbortController().signal;
  const bytes = new Uint8Array([0, 255, 1]);
  const purpose = provider === "aws" ? "task_image" : "task_attachment";
  const selected = provider === "aws" ? new File([bytes], "图.png", { type: "image/png" }) : new File([bytes], "archive.zip", { type: "application/zip" });
  const contentType = purpose === "task_image" ? selected.type : "application/octet-stream";
  const desktopFetch = mock(async (command: string, url: string, init: RequestInit) => {
    expect(command).toBe("__fetch");
    expect(url).toBe(denUrl);
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer den-session");
    expect(headers.get("x-jugglework-legacy-org-id")).toBe(options.organizationId);
    expect(JSON.parse(String(init.body))).toEqual({
      purpose, taskId: options.taskId, fileName: selected.name, contentType, sizeBytes: bytes.length, uploadProtocol: "put-v1",
    });
    return { status: 200, body: JSON.stringify({
      ...putGrant, provider, uploadUrl, headers: { "content-TYPE": contentType, [conditional]: condition },
    }) };
  });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { origin: "https://renderer.test" }, __JUGGLEWORK_ELECTRON__: { invokeDesktop: desktopFetch },
  } });
  const directFetch = mock(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe(uploadUrl);
    expect(init).toMatchObject({ method: "PUT", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    expect(init?.signal).toBe(signal);
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({ "content-type": contentType, [conditional]: condition });
    expect(init?.body).toBeInstanceOf(Blob);
    const body = init?.body as Blob;
    expect(body.type).toBe(contentType);
    expect(new Uint8Array(await body.arrayBuffer())).toEqual(bytes);
    return new Response(null, { status: 204 });
  });
  replaceFetch(directFetch);
  try {
    const result = await uploadBusinessFile({ ...options, client: denClient(), purpose, file: selected, signal });
    expect(result).toEqual({ name: selected.name, url: putGrant.fileUrl });
    expect(desktopFetch).toHaveBeenCalledTimes(1);
    expect(directFetch).toHaveBeenCalledTimes(1);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
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

test("PUT refuses unsafe or inexact headers before sending bytes", async () => {
  const invalidHeaders = [
    ...Object.entries({ Authorization: "Bearer injected", Cookie: "injected=yes", "Content-Length": "5", "x-amz-acl": "public-read", "x-jugglework-legacy-org-id": "org/a" })
      .map(([name, value]) => ({ ...putGrant.headers, [name]: value })),
    { ...putGrant.headers, "content-type": file.type },
    { "Content-Type": file.type, "content-type": file.type },
    { ...putGrant.headers, "if-none-match": "*" },
    { "Content-Type": file.type, "x-oss-forbid-overwrite": "true" },
    { ...putGrant.headers, "If-None-Match": " * " },
    { ...putGrant.headers, "Content-Type": "image/png; charset=utf-8" },
    { ...putGrant.headers, "Content-Type": "application/octet-stream" },
    { ...putGrant.headers, "Content-Type": [file.type] },
    { "Content-Type": file.type },
    Object.entries(putGrant.headers),
    null,
  ];
  const request = mock(async () => new Response(null, { status: 204 }));
  replaceFetch(request);
  for (const headers of invalidHeaders) {
    await expect(uploadBusinessFile({ ...options, client: clientWithGrant({ ...putGrant, headers }) })).rejects.toThrow("上传凭据");
  }
  for (const headers of [putGrant.headers, { "Content-Type": file.type, "x-oss-forbid-overwrite": "false" }]) {
    const client = clientWithGrant({
      ...putGrant, provider: "oss", uploadUrl: "https://bucket.oss.test/objects/123?x-oss-signature=fixture", headers,
    });
    await expect(uploadBusinessFile({ ...options, client })).rejects.toThrow("上传凭据");
  }
  expect(request).not.toHaveBeenCalled();
});

test("PUT validates provider, method, expiry, signed HTTPS upload and unsigned key-matching HTTPS download", async () => {
  const base = putGrant.uploadUrl.split("?")[0];
  const invalid = [
    { provider: "other" }, { method: "POST" }, { method: "put" }, { expiresAt: "2000-01-01" }, { key: "" },
    ...[base, `${base}?not-a-signature=fixture`, `${base}?X-Amz-Signature=`, `${putGrant.uploadUrl}&X-Amz-Signature=duplicate`,
      putGrant.uploadUrl.replace("https:", "http:"), putGrant.uploadUrl.replace("bucket.", "user:pass@bucket."),
      putGrant.uploadUrl.replace("bucket.", "@bucket."), `${putGrant.uploadUrl}#`].map(uploadUrl => ({ uploadUrl })),
    ...[putGrant.uploadUrl, putGrant.fileUrl.replace("https:", "http:"), putGrant.fileUrl.replace("cdn.", "user@cdn."),
      `${putGrant.fileUrl}?X-Amz-Signature=fixture`, `${putGrant.fileUrl}?`, `${putGrant.fileUrl}#fragment`, `${putGrant.fileUrl}#`,
      "https://cdn.test/other-objects/123", "https://cdn.test/assets/objects/123/other", "https://cdn.test/assets/objects%2F123",
      "https://cdn.test/assets/objects/123/../other"].map(fileUrl => ({ fileUrl })),
  ];
  const request = mock(async () => new Response(null, { status: 204 }));
  replaceFetch(request);
  for (const change of invalid) {
    await expect(uploadBusinessFile({ ...options, client: clientWithGrant({ ...putGrant, ...change }) })).rejects.toThrow("上传凭据");
  }
  expect(request).not.toHaveBeenCalled();
});

test("MinIO can use the same HTTPS origin for PUT and unsigned downloads", async () => {
  const fileUrl = `https://minio.test:9443/bucket/${putGrant.key}`;
  const uploadUrl = `${fileUrl}?X-Amz-Signature=fixture`;
  const client = clientWithGrant({ ...putGrant, provider: "minio", fileUrl, uploadUrl });
  const request = mock(async () => new Response(null, { status: 204 }));
  replaceFetch(request);
  expect(await uploadBusinessFile({ ...options, client })).toEqual({ url: fileUrl, name: file.name });
  expect(request).toHaveBeenCalledTimes(1);
});

test("PUT failures do not release a URL, retry, or surface signed URLs in errors", async () => {
  const client = { createFileUploadCredentials: async () => putGrant };
  for (const status of [302, 403, 412, 500]) {
    const request = mock(async () => new Response(putGrant.uploadUrl, { status }));
    replaceFetch(request);
    await expect(uploadBusinessFile({ ...options, client })).rejects.toMatchObject({ message: `文件上传失败（HTTP ${status}）。` });
    expect(request).toHaveBeenCalledTimes(1);
  }
  replaceFetch(async () => { throw new TypeError(`Network error for ${putGrant.uploadUrl}`); });
  await expect(uploadBusinessFile({ ...options, client })).rejects.toMatchObject({ message: "文件上传失败，请重试。" });
});

test("PUT does not release a URL if aborted while uploading", async () => {
  const controller = new AbortController();
  const client = { createFileUploadCredentials: async () => putGrant };
  replaceFetch(async () => { controller.abort(); return new Response(null, { status: 204 }); });
  await expect(uploadBusinessFile({ ...options, client, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
});

test("aborting while Den is issuing credentials prevents the storage POST", async () => {
  const controller = new AbortController();
  const post = mock(async () => Response.json({}));
  replaceFetch(post);
  const client = { createFileUploadCredentials: async () => { controller.abort(); return grant; } };
  await expect(uploadBusinessFile({ ...options, client, signal: controller.signal })).rejects.toThrow();
  expect(post).not.toHaveBeenCalled();
});
