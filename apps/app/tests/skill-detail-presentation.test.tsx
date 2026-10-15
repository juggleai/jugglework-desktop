/** @jsxImportSource react */
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { t } from "../src/i18n";
import type { GlobalSkillsViewProps } from "../src/react-app/domains/settings/pages/global-skills-view";

const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("../src/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: box,
  DialogHeader: box,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
// The shared shell owns the breadcrumb/title; these tests exercise its skill body contract.
mock.module("../src/react-app/domains/settings/pages/catalog-detail-page", () => ({
  CatalogDetailPage: ({ categoryLabel, name, description, children, onBack }: { categoryLabel: string; name: string; description?: string; children: ReactNode; onBack: () => void }) => (
    <section data-testid="detail-page"><button onClick={onBack}>{categoryLabel}</button><h1>{name}</h1><p>{description}</p>{children}</section>
  ),
}));
mock.module("../src/react-app/domains/session/surface/markdown", () => ({
  MarkdownBlock: ({ text }: { text: string }) => <article>{text}</article>,
}));
const readLocalSkill = mock(async (_projectDir: string, name: string) => ({ content: `---\nname: ${name}\n---\nInstructions for ${name}`, path: `/global/${name}/SKILL.md` }));
const listSkillFiles = mock(async (_dir: string) => ({ files: [{ relPath: "SKILL.md", size: 120 }] }));
const desktop = await import("../src/app/lib/desktop");
mock.module("../src/app/lib/desktop", () => ({ ...desktop, desktopBridge: { ...desktop.desktopBridge, readLocalSkill, listSkillFiles } }));
mock.module("../src/react-app/domains/settings/pages/project-extensions/skill-add-menu", () => ({
  SkillAddMenu: ({ onUpload, onOpenSkillHub }: { onUpload: () => void; onOpenSkillHub: () => void }) => <><button onClick={onUpload}>Upload</button><button onClick={onOpenSkillHub}>SkillHub</button></>,
}));
mock.module("../src/react-app/domains/settings/pages/project-extensions/skill-hub-modal", () => ({
  SkillHubModal: ({ open }: { open: boolean }) => open ? <div role="dialog">SkillHub dialog</div> : null,
}));
mock.module("../src/react-app/design-system/modals/confirm-modal", () => ({
  ConfirmModal: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => open ? <div role="dialog"><button onClick={onConfirm}>Confirm deletion</button></div> : null,
}));

const { GlobalSkillsView } = await import("../src/react-app/domains/settings/pages/global-skills-view");
const { SkillDetailModal } = await import("../src/react-app/domains/settings/pages/project-extensions/skill-detail-modal");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
const local = { name: "writer", description: "Write documents", path: "/global/writer", scope: "global" as const };
const creator = { name: "skill-creator", description: "Create skills", path: "/global/skill-creator", scope: "global" as const, sourceKind: "public" as const };
const org = { id: "review-id", name: "reviewer", description: "Review documents", path: "", content: "Full team instructions" };
const defaults: GlobalSkillsViewProps = {
  detailPresentation: "page", source: "personal", busy: false, canAddSkills: true,
  skills: [local], organizationSkills: [org], projectDir: "/workspace",
  onDeleteSkill: noop, onUploadSkill: noop, onRefresh: noop,
  loadSkillDetail: async (skill) => ({ content: `Instructions for ${skill.name}`, path: skill.path, files: [{ relPath: "SKILL.md", size: 120 }] }),
};
let renderer: TestRenderer.ReactTestRenderer;
let props: GlobalSkillsViewProps;
async function render(overrides: Partial<GlobalSkillsViewProps> = {}) {
  props = { ...defaults, ...overrides };
  await act(async () => { renderer = TestRenderer.create(<GlobalSkillsView {...props} />); });
}
async function update(overrides: Partial<GlobalSkillsViewProps>) {
  props = { ...props, ...overrides };
  await act(async () => renderer.update(<GlobalSkillsView {...props} />));
}
const root = () => renderer.root;
const text = () => JSON.stringify(renderer.toJSON());
const pages = () => root().findAllByProps({ "data-testid": "detail-page" });
async function click(label: string) {
  await act(async () => root().findAllByType("button").find((button) => button.children.includes(label))!.props.onClick());
}
async function card(name: string) {
  await act(async () => root().findAllByType("button").find((button) => button.findAllByType("div").some((div) => div.children.includes(name)))!.props.onClick());
}
beforeEach(() => { readLocalSkill.mockClear(); listSkillFiles.mockClear(); });
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); });

test("cards and installed shortcuts share an inline body; back preserves search and nonce permits reopening", async () => {
  await render();
  await act(async () => root().findByType("input").props.onChange({ currentTarget: { value: "Write" } }));
  await card("writer");
  expect(pages()).toHaveLength(1);
  expect(root().findAllByType("input")).toHaveLength(0);
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(0);
  expect(root().findAllByType("h2")).toHaveLength(0);
  expect(text()).toContain("Instructions for writer");
  await click(t("settings.tab_skills"));
  expect(root().findByType("input").props.value).toBe("Write");
  await act(async () => root().findByType("input").props.onChange({ currentTarget: { value: "no match" } }));
  const request = { id: "global-skill:/global/writer", nonce: 1 };
  await update({ detailRequest: request });
  expect(pages()).toHaveLength(1);
  expect(text()).toContain("Instructions for writer");
  await click(t("settings.tab_skills"));
  await update({ detailRequest: { ...request }, skills: [...defaults.skills] });
  expect(pages()).toHaveLength(0);
  expect(root().findByType("input").props.value).toBe("no match");
  await update({ detailRequest: { ...request, nonce: 2 } });
  expect(pages()).toHaveLength(1);
});

test("local shortcuts wait for inventory and prefer path to a conflicting name", async () => {
  const detailRequest = { id: "global-skill:other", name: "other", path: local.path, nonce: 1 };
  await render({ detailRequest, busy: true, skills: [local, { ...local, name: "other", path: "/global/other" }] });
  expect(pages()).toHaveLength(0);
  await update({ busy: false, skills: [] });
  expect(pages()).toHaveLength(0);
  await update({ skills: [local, { ...local, name: "other", path: "/global/other" }] });
  expect(root().findByType("h1").children).toEqual(["writer"]);
});

test("pathless local identities fall back to names", async () => {
  await render({ skills: [{ ...local, path: "" }], detailRequest: { id: "global-skill:writer", nonce: 1 } });
  expect(pages()).toHaveLength(1);
});

test.each(["review-id", "reviewer", "org-skill:team-id:review-id", "org-skill:team-id:reviewer"])("organization identity %s waits for inventory and retains full content without local reads", async (id) => {
  await render({ source: "organization", orgSkillsLoading: true, detailRequest: { id, nonce: 1 } });
  expect(pages()).toHaveLength(0);
  await update({ orgSkillsLoading: false, organizationSkills: [] });
  expect(pages()).toHaveLength(0);
  await update({ organizationSkills: [org] });
  expect(pages()).toHaveLength(1);
  expect(text()).toContain(org.content);
  expect(text()).toContain(org.description);
  expect(text()).toContain(t("project_extensions.detail_tab_overview"));
  expect(text()).not.toContain(t("project_extensions.detail_tab_files"));
  expect(root().findByType("article").children).toEqual([org.content]);
  expect(readLocalSkill).not.toHaveBeenCalled();
  expect(listSkillFiles).not.toHaveBeenCalled();
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(0);
  await click(t("settings.tab_skills"));
  await card(org.name);
  expect(text()).toContain(org.content);
});

test("organization source is sanitized Markdown rather than exposed raw source text", async () => {
  const source = `---\nname: reviewer\n---\n# Rendered heading\n<script>window.__leaked = true</script>\n**Formatted body**`;
  const loadSkillDetail = mock(async () => { throw new Error("Organization must not call the personal loader"); });
  await render({ source: "organization", organizationSkills: [{ ...org, content: source }], loadSkillDetail });
  await card(org.name);
  expect(text()).not.toContain("name: reviewer");
  expect(root().findAllByType("script")).toHaveLength(0);
  expect(text()).toContain(t("project_extensions.detail_tab_overview"));
  expect(text()).not.toContain(t("project_extensions.detail_tab_files"));
  expect(root().findByType("article").children).toEqual(["# Rendered heading\n<script>window.__leaked = true</script>\n**Formatted body**"]);
  expect(loadSkillDetail).not.toHaveBeenCalled();
  expect(readLocalSkill).not.toHaveBeenCalled();
  expect(listSkillFiles).not.toHaveBeenCalled();
});

test("local exact details show Files only when the runtime returns a file inventory", async () => {
  const withFiles = mock(async (skill: typeof local) => ({ content: "Local content", path: skill.path, files: [{ relPath: "SKILL.md", size: 12 }] }));
  await render({ loadSkillDetail: withFiles, detailRequest: { id: `global-skill:${local.path}`, nonce: 1 } });
  expect(text()).toContain(t("project_extensions.detail_tab_files"));

  const withoutFiles = mock(async (skill: typeof local) => ({ content: "Metadata only", path: skill.path, files: [] }));
  await update({ loadSkillDetail: withoutFiles, detailRequest: { id: `global-skill:${local.path}`, nonce: 2 } });
  expect(text()).not.toContain(t("project_extensions.detail_tab_files"));
});

test("organization request name fallback and source changes do not revive consumed requests", async () => {
  await render({ source: "organization", detailRequest: { id: "sidebar-key", name: org.name, nonce: 1 } });
  expect(pages()).toHaveLength(1);
  await update({ source: "personal" });
  expect(pages()).toHaveLength(0);
  await update({ source: "organization" });
  expect(pages()).toHaveLength(0);
});

test("Public lists the preinstalled skill creator, excludes it from Personal, and opens its exact detail", async () => {
  const loadSkillDetail = mock(async (skill: typeof creator) => ({
    content: `---\nname: ${skill.name}\n---\nBundled creator instructions`,
    path: skill.path,
    files: [{ relPath: "SKILL.md", size: 120 }],
  }));
  await render({ source: "public", skills: [local, creator], loadSkillDetail });
  expect(text()).toContain("skill-creator");
  expect(text()).not.toContain("Write documents");
  await card("skill-creator");
  expect(pages()).toHaveLength(1);
  expect(text()).toContain("Bundled creator instructions");
  expect(loadSkillDetail).toHaveBeenCalledWith(expect.objectContaining({ name: "skill-creator", path: creator.path }));

  await update({ source: "personal" });
  expect(text()).not.toContain("skill-creator");
  expect(text()).toContain("writer");
});

test("an independent same-name skill remains Personal and is not used as the Public install", async () => {
  const userCreator = { ...creator, path: "/global/user-skill-creator", sourceKind: "standalone" as const };
  await render({ source: "public", skills: [userCreator] });
  await card("skill-creator");
  expect(text()).toContain("Create or update a skill");

  await update({ source: "personal" });
  expect(text()).toContain("skill-creator");
});

test.each(["personal", "organization"] as const)("legacy %s details remain dialogs with the list visible", async (source) => {
  await render({ source, detailPresentation: undefined });
  await card(source === "personal" ? local.name : org.name);
  expect(pages()).toHaveLength(0);
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(1);
  expect(root().findAllByType("input")).toHaveLength(1);
  expect(text()).toContain(source === "personal" ? "Instructions for writer" : org.content);
  await click(t("common.close"));
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(0);
});

test("page mode keeps SkillHub and uninstall confirmation as dialogs", async () => {
  const remove = mock(noop);
  const upload = mock(noop);
  await render({ onDeleteSkill: remove, onUploadSkill: upload });
  await click("Upload");
  expect(upload).toHaveBeenCalledTimes(1);
  await act(async () => root().findByProps({ "aria-label": t("skills.uninstall") }).props.onClick({ stopPropagation: noop }));
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(1);
  expect(remove).not.toHaveBeenCalled();
  await click("Confirm deletion");
  expect(remove).toHaveBeenCalledWith(local.name);
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(0);
  await click("SkillHub");
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(1);
});

test("legacy project modal retains lazy desktop file browsing and strips frontmatter", async () => {
  const skill = { ...local, scope: "project" as const };
  await act(async () => { renderer = TestRenderer.create(<SkillDetailModal open skill={skill} projectDir="/workspace" onClose={noop} />); });
  expect(readLocalSkill).toHaveBeenCalledWith("/workspace", local.name);
  expect(root().findByType("article").children).toEqual(["Instructions for writer"]);
  expect(listSkillFiles).not.toHaveBeenCalled();
  await click(t("project_extensions.detail_tab_files"));
  expect(listSkillFiles).toHaveBeenCalledWith("/global/writer");
  expect(text()).toContain("SKILL.md");
  expect(root().findAllByProps({ role: "dialog" })).toHaveLength(1);
  expect(root().findAllByType("h2")).toHaveLength(1);
  await act(async () => renderer.update(<SkillDetailModal open={false} skill={skill} projectDir="/workspace" onClose={noop} />));
  expect(renderer.toJSON()).toBeNull();
});

test.each(["modal", "page"] as const)("%s global details load the selected same-name path without desktop fallback", async (detailPresentation) => {
  const other = { ...local, path: "/remote/global/writer/SKILL.md" };
  const loadSkillDetail = mock(async (skill: typeof local) => ({ content: `---\nname: writer\n---\nExact: ${skill.path}`, path: skill.path, files: [
    { relPath: "SKILL.md", size: 120 },
    { relPath: "references/guide.md", size: 2048 },
  ] }));
  await render({ detailPresentation, skills: [local, other], loadSkillDetail, detailRequest: { id: `global-skill:${other.path}`, nonce: 1 } });
  expect(loadSkillDetail).toHaveBeenCalledWith(other);
  expect(root().findByType("article").children).toEqual([`Exact: ${other.path}`]);
  expect(readLocalSkill).not.toHaveBeenCalled();
  expect(listSkillFiles).not.toHaveBeenCalled();
  await click(t("project_extensions.detail_tab_files"));
  expect(text()).toContain("SKILL.md");
  expect(text()).toContain("references");
  expect(text()).toContain(t("project_extensions.detail_file_count", { count: 2 }));
  expect(listSkillFiles).not.toHaveBeenCalled();
});

test.each(["missing", "rejected"] as const)("%s exact loader leaves metadata only, never a same-name desktop read", async (mode) => {
  await render({ loadSkillDetail: mode === "missing" ? undefined : async () => { throw new Error("Outside workspace"); }, detailRequest: { id: `global-skill:${local.path}`, nonce: 1 } });
  expect(text()).toContain(local.description);
  expect(root().findAllByType("article")).toHaveLength(0);
  expect(readLocalSkill).not.toHaveBeenCalled();
  expect(listSkillFiles).not.toHaveBeenCalled();
});

test("supplied content wins over the loader, including organization content", async () => {
  const loadSkillDetail = mock(async () => { throw new Error("Must not read"); });
  const skill = { ...org, origin: "jugglework-connect" as const };
  await act(async () => { renderer = TestRenderer.create(<SkillDetailModal open skill={skill} projectDir="/workspace" onClose={noop} presentation="page" loadSkillDetail={loadSkillDetail} />); });
  expect(root().findByType("article").children).toEqual([org.content]);
  expect(loadSkillDetail).not.toHaveBeenCalled();
  expect(readLocalSkill).not.toHaveBeenCalled();
});

test.each(["modal", "page"] as const)("standalone %s global skill without an exact loader stays metadata-only", async (presentation) => {
  await act(async () => { renderer = TestRenderer.create(<SkillDetailModal open skill={local} projectDir="/workspace" onClose={noop} presentation={presentation} />); });
  expect(text()).toContain(local.description);
  expect(root().findAllByType("article")).toHaveLength(0);
  expect(readLocalSkill).not.toHaveBeenCalled();
  expect(listSkillFiles).not.toHaveBeenCalled();
});

test("same-name selection changes ignore late content and clear earlier loaded content", async () => {
  const other = { ...local, path: "/remote/other/writer/SKILL.md" };
  let complete!: (value: { content: string; path: string; files: { relPath: string; size: number }[] }) => void;
  const loadSkillDetail = mock((skill: typeof local) => skill === local
    ? new Promise<{ content: string; path: string; files: { relPath: string; size: number }[] }>((resolve) => { complete = resolve; })
    : Promise.resolve({ content: "Selected remote content", path: skill.path, files: [{ relPath: "selected.md", size: 10 }] }));
  const node = (skill: typeof local) => <SkillDetailModal open skill={skill} projectDir="/workspace" onClose={noop} presentation="page" loadSkillDetail={loadSkillDetail} />;
  await act(async () => { renderer = TestRenderer.create(node(local)); });
  await act(async () => renderer.update(node(other)));
  await act(async () => complete({ content: "Wrong late content", path: local.path, files: [{ relPath: "wrong.md", size: 10 }] }));
  expect(root().findByType("article").children).toEqual(["Selected remote content"]);
  await act(async () => renderer.update(node(local)));
  expect(root().findAllByType("article")).toHaveLength(0);
  expect(readLocalSkill).not.toHaveBeenCalled();
});
