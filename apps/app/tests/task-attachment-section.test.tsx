import * as React from "react";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { splitTaskAttachments, joinTaskAttachments } from "../src/react-app/domains/tasks/task-description-markdown";
import { TaskAttachmentSection } from "../src/react-app/domains/tasks/task-attachment-section";

test("task attachment cards preserve legacy unknown sizes and exclude inline images and code", () => {
  const old = '[old.pdf](https://files.test/old.pdf "task-file")';
  const body = `![figure](https://files.test/image.png "task-file")\n\`${old}\``;
  const next = { name: "图[1].pdf", size: 1234567, url: "https://files.test/new.pdf" };
  const draft = joinTaskAttachments(`${body}\n${old}`, [next]);
  const split = splitTaskAttachments(draft);
  expect(split.body).toBe(body);
  expect(split.files).toEqual([{ name: "old.pdf", url: "https://files.test/old.pdf", size: null }, next]);
  expect(joinTaskAttachments(split.body, split.files)).toBe(draft);
  const html = renderToStaticMarkup(<TaskAttachmentSection files={split.files} onAdd={() => {}} />);
  expect(html).toContain("old.pdf"); expect(html).toContain("1.23 MB");
  expect(html).not.toContain('type="file"');
});

test("extracting a draft's files preserves authored line breaks, links, images and code examples", () => {
  const example = '[example.pdf](https://files.test/sample.pdf "task-file")';
  const file = { name: "Plan (<1>).pdf", size: 15, url: "https://files.test/plan.pdf" };
  const body = `![image](https://files.test/image.png) [link](https://example.test)\n~~~md\n${example}\n~~~\n    ${example}\n\n`;
  expect(splitTaskAttachments(joinTaskAttachments(body, [file]))).toEqual({ body, files: [file] });
});
