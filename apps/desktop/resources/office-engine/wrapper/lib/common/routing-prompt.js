"use strict";
/**
 * User-prompt-side **routing block** for Office Docs — thin layer.
 *
 * Renders the `<office_docs_editor_context>` hidden user-prompt block. After the
 * routing policy (the HOW) was extracted into the shared `office-docs-routing`
 * skill, this block carries ONLY what the host knows at runtime and the skill
 * cannot, plus the LOCAL-channel **priority & fallback** policy (kept here so
 * the fallback ladder is reasserted at the fresh attention position of every
 * routing turn; remote / online MCP guidance is omitted):
 *
 *   1. the **trigger** decision — does this turn touch a Office Docs resource
 *      at all (a local office file, or a `@tdoc://` reference);
 *   2. the **per-turn dynamic context** — which local files / remote docs are
 *      in play, the active document, and each resource's authoritative
 *      `type="local|remote"` channel stamp. The host derives that stamp from
 *      the resource scheme (`file://` vs `tdoc://`), NOT by guessing from the
 *      path string, so it is the single source of truth for local-vs-online;
 *   3. (LOCAL only) an imperative pointer telling the model it MUST invoke the
 *      `office-docs-routing` skill before content work on local documents —
 *      online / remote docs do **not** go through that skill;
 *   4. the LOCAL-channel **priority & fallback** policy
 *      ({@link buildLocalChannelPriorityAndFallback}); remote documents keep
 *      their dynamic inventory only — no skill pointer and no online-MCP
 *      fallback ladder here;
 *   5. (LOCAL `skill` mode only) a brief two-skill division note naming
 *      `office-docs-routing` (the *decision* skill) vs `office-local-edit`
 *      (the *work* skill), so the model does not conflate the two before it has
 *      invoked routing ({@link buildLocalSkillToolsAccessNote}). The local
 *      engine's actual tool catalog / file_id ladder stays in the skill.
 *
 * # Why most of the policy is no longer here
 *
 * Local-vs-online classification rules, the `file_id` lookup recipe, the
 * cross-channel fence and the URL-integrity rule all live in the
 * `office-docs-routing` skill now. Keeping them out of this block:
 *   - removes the drift that let this block contradict the skill (the block
 *     used to frame the skill as an executor and treat any direct MCP call as
 *     a failure-only fallback, while the skill itself routes simple ops to a
 *     direct MCP call as the primary path), and
 *   - removes the concrete operational recipes (`get_pool_status`,
 *     `open_file`, …) that let strong models feel equipped to act WITHOUT ever
 *     invoking the skill.
 *
 * The LOCAL priority & fallback ladder is the deliberate exception: it stays in
 * this block so each routing turn reasserts "go through the skill first; only
 * step down a rung on a concrete failure" right next to the local document
 * inventory. Remote / online MCP fallback guidance is intentionally omitted.
 *
 * # Host responsibility
 *
 * Hosts feed this function pure data ({@link OfficeDocsRoutingPromptInput}).
 * The host already knows local vs remote from the resource scheme and passes
 * the matching `ActiveDocument` variant / `attachedFilePaths` / `remoteDocs`;
 * this block only stamps that fact as `type=`. The "how to preview / display a
 * local document" material is UI-surface specific and is not owned by the
 * shared skill; hosts should carry it in their own capability section of the
 * user-context reminder (e.g. jugglework's `<jugglework_local_preview_capability>`)
 * rather than splicing it into this block. `localPreviewIntentInstructions` is
 * retained only for backward compatibility with hosts that still inject it.
 * `tdoc-selection://` ContentBlocks are deliberately excluded here;
 * they belong to `selection-prompt.ts`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isLocalOfficeFilePath = isLocalOfficeFilePath;
exports.renderOfficeDocsRoutingPrompt = renderOfficeDocsRoutingPrompt;
const extensions_1 = require("./extensions");
/**
 * Returns `true` iff `filePath`'s extension is in
 * {@link SCENARIO_DETECTABLE_EXTENSIONS} — i.e. it is a Office-Docs-routable
 * **local** office file. `.csv` is intentionally excluded (it would trigger
 * the routing block on every dev workflow that uses pandas / awk on CSVs).
 *
 * Exposed because hosts often need this same gate when deciding whether to
 * also surface the file in non-routing UI / prompt paths.
 */
function isLocalOfficeFilePath(filePath) {
    const dot = filePath.lastIndexOf('.');
    if (dot < 0 || dot === filePath.length - 1) {
        return false;
    }
    const ext = filePath.slice(dot).toLowerCase();
    return extensions_1.SCENARIO_DETECTABLE_EXTENSIONS.has(ext);
}
function getPathBaseName(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    const slash = normalized.lastIndexOf('/');
    return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}
/**
 * Render the `<office_docs_editor_context>` block as a `string[]` of lines.
 *
 * Returns an **empty array** when neither channel has anything to route in
 * this turn — callers should treat that as "skip this section entirely",
 * NOT as "emit an empty `<office_docs_editor_context></office_docs_editor_context>`
 * frame". An empty frame would tell the model "Office Docs routing applies
 * but there's nothing to route", which is confusing.
 */
function renderOfficeDocsRoutingPrompt(input) {
    const localMode = input.localChannelMode ?? 'mcp';
    const attachedFilePaths = input.attachedFilePaths ?? [];
    const mentionedLocalOfficeFileNames = input.mentionedLocalOfficeFileNames ?? [];
    const remoteDocs = input.remoteDocs ?? [];
    const localPreviewIntentInstructions = input.localPreviewIntentInstructions ?? [];
    const activeDoc = input.activeDocument;
    const attachedOfficeFiles = attachedFilePaths.filter(isLocalOfficeFilePath);
    const activeDocIsLocalOffice = activeDoc?.type === 'local' && isLocalOfficeFilePath(activeDoc.filePath);
    const resolvedLocalOfficeFileNames = new Set([
        ...attachedOfficeFiles.map(getPathBaseName),
        ...(activeDocIsLocalOffice ? [getPathBaseName(activeDoc.filePath)] : []),
    ]);
    const mentionedOfficeFileNames = mentionedLocalOfficeFileNames
        .filter(isLocalOfficeFilePath)
        .filter((name) => !resolvedLocalOfficeFileNames.has(name));
    const activeDocIsRemote = activeDoc?.type === 'remote';
    const hasLocalOfficeFiles = attachedOfficeFiles.length > 0 || mentionedOfficeFileNames.length > 0 || activeDocIsLocalOffice;
    const hasRemoteDocs = remoteDocs.length > 0 || activeDocIsRemote;
    if (!hasLocalOfficeFiles && !hasRemoteDocs) {
        return [];
    }
    // First routing turn of the session vs. a later one. The host tracks this and
    // passes it via `includeStaticRules`; here it decides whether to push the
    // model to INVOKE the skill (first turn) or to REUSE the guidance it already
    // loaded earlier (later turns) — so the skill fires once per session, not
    // every turn. It also gates the LOCAL priority & fallback policy below.
    // The skill HEADER / RECALL only applies when local documents are in play —
    // online / remote docs do not go through `office-docs-routing`. The
    // document inventory renders either way.
    const isFirstRouting = input.includeStaticRules ?? true;
    const lines = ['<office_docs_editor_context>'];
    if (hasLocalOfficeFiles) {
        lines.push(isFirstRouting ? OFFICE_DOCS_ROUTING_HEADER : OFFICE_DOCS_ROUTING_HEADER_RECALL);
    }
    // ── Local channel dynamic context ──
    if (hasLocalOfficeFiles) {
        lines.push('', '## Local document context');
        if (activeDocIsLocalOffice) {
            const attrs = ['type="local"', `path="${escapeXmlAttribute(activeDoc.filePath)}"`];
            if (activeDoc.fileId) {
                attrs.push(`file_id="${escapeXmlAttribute(activeDoc.fileId)}"`);
            }
            lines.push('Active local document from the current Office Docs preview:', `<active_document ${attrs.join(' ')} />`, `The user is currently focused on this active local document. ` +
                `Unless the user specifies another file, prefer it. ` +
                `If the user asks what document is currently open or being previewed, answer from this context.`);
        }
        if (attachedOfficeFiles.length > 0) {
            lines.push('Local office files explicitly referenced or attached in this user turn:', '<local_files>', ...attachedOfficeFiles.map((filePath) => `<file path="${escapeXmlAttribute(filePath)}" />`), '</local_files>');
        }
        if (mentionedOfficeFileNames.length > 0) {
            lines.push('Local office filenames mentioned without absolute paths:', '<local_file_mentions>', ...mentionedOfficeFileNames.map((name) => `<file name="${escapeXmlAttribute(name)}" />`), '</local_file_mentions>');
        }
        // Host-injected preview/display section (UI-surface specific; not owned by
        // the shared skill). Spliced into the local area only when provided.
        if (localPreviewIntentInstructions.length > 0) {
            lines.push(...localPreviewIntentInstructions);
        }
        // Skill-mode only: name the two skills' division of labor before the policy,
        // so the model does not conflate the decision skill with the work skill.
        // First routing turn only — like the priority policy, later turns rely on
        // the guidance already loaded into context.
        if (isFirstRouting && localMode === 'skill') {
            lines.push(...buildLocalSkillToolsAccessNote());
        }
        // Local priority & fallback policy (first routing turn only).
        if (isFirstRouting) {
            lines.push('', '## Local Office Docs content work', ...buildLocalChannelPriorityAndFallback(localMode));
        }
    }
    // ── Remote channel dynamic context ──
    if (hasRemoteDocs) {
        // Blank separator only when Local (or its HEADER) already occupies the block;
        // remote-only turns should not open with an empty line after the tag.
        if (lines.length > 1) {
            lines.push('');
        }
        lines.push('## Remote Office Docs context');
        if (activeDocIsRemote) {
            const { doc } = activeDoc;
            // `type="remote"` 标识 channel；文档自身类型走 `doc_type=`，
            // 避免与 channel 属性同名冲突（XML 重复属性语义未定义）。
            const attrs = [
                'type="remote"',
                `id="${escapeXmlAttribute(doc.fileId)}"`,
                `title="${escapeXmlAttribute(doc.title)}"`,
            ];
            if (doc.fileExt) {
                attrs.push(`ext="${escapeXmlAttribute(doc.fileExt)}"`);
            }
            if (doc.fileType) {
                attrs.push(`doc_type="${escapeXmlAttribute(doc.fileType)}"`);
            }
            if (doc.ownerName) {
                attrs.push(`owner="${escapeXmlAttribute(doc.ownerName)}"`);
            }
            if (doc.url) {
                attrs.push(`url="${escapeXmlAttribute(doc.url)}"`);
            }
            if (doc.tdocMcpSessionId) {
                attrs.push(`tdocMcpSessionId="${escapeXmlAttribute(doc.tdocMcpSessionId)}"`);
            }
            lines.push('Active remote Office Doc from the current Office Docs window:', `<active_document ${attrs.join(' ')} />`, `The user is currently focused on this active remote cloud-hosted Office Doc. ` +
                `When the user's intent is ambiguous or does not specify a file, prioritize it. ` +
                `Pass its \`id\` as the \`file_id\` argument. ` +
                `Do not use the \`office-docs-routing\` skill for online / remote documents.`);
        }
        if (remoteDocs.length > 0) {
            lines.push('Remote Office Docs explicitly referenced or attached in this user turn:', '<references>');
            for (const doc of remoteDocs) {
                const attrs = [
                    `id="${escapeXmlAttribute(doc.fileId)}"`,
                    `title="${escapeXmlAttribute(doc.title)}"`,
                ];
                if (doc.fileExt) {
                    attrs.push(`ext="${escapeXmlAttribute(doc.fileExt)}"`);
                }
                if (doc.fileType) {
                    // 与 <active_document /> 保持一致：文档自身类型走 `doc_type=`，
                    // 避免后续 active_document 的 `type="remote"` 引起属性重名混淆。
                    attrs.push(`doc_type="${escapeXmlAttribute(doc.fileType)}"`);
                }
                if (doc.ownerName) {
                    attrs.push(`owner="${escapeXmlAttribute(doc.ownerName)}"`);
                }
                if (doc.url) {
                    attrs.push(`url="${escapeXmlAttribute(doc.url)}"`);
                }
                if (doc.tdocMcpSessionId) {
                    attrs.push(`tdocMcpSessionId="${escapeXmlAttribute(doc.tdocMcpSessionId)}"`);
                }
                lines.push(`<doc ${attrs.join(' ')} />`);
            }
            lines.push('</references>');
        }
    }
    lines.push('</office_docs_editor_context>');
    return lines;
}
// ─── internals ─────────────────────────────────────────────────────────────
/**
 * First-turn LOCAL routing-block header — the imperative pointer that rides
 * with the local document inventory below it.
 *
 * Emitted only when local office files are in play. Online / remote documents
 * do **not** go through `office-docs-routing`; their section carries inventory
 * only and explicitly tells the model not to use this skill.
 *
 * Used only on the FIRST local routing turn of a session; later local turns
 * swap in {@link OFFICE_DOCS_ROUTING_HEADER_RECALL}.
 */
const OFFICE_DOCS_ROUTING_HEADER = 'Before working with any local Office Docs document, invoke the `office-docs-routing` skill to determine the correct tool path. ' +
    'Purely local file operations that do not touch document content (e.g. format conversion like docx→pdf) are the exception and do not need the skill. ' +
    'Online / remote Office Docs do not use this skill.';
/**
 * Later-turn LOCAL routing-block header. Once the model has invoked the
 * `office-docs-routing` skill earlier in the session for local documents, its
 * guidance is still in context — point back at it instead of re-invoking.
 * Not emitted on remote-only turns.
 */
const OFFICE_DOCS_ROUTING_HEADER_RECALL = 'Local Office Docs document(s) are in play this turn (listed below). You already invoked the `office-docs-routing` skill ' +
    'earlier this session, so its routing guidance is still in context — MUST follow it for any content work on local documents below. ' +
    'No need to re-invoke the skill unless you need to re-read that guidance. Online / remote Office Docs do not use this skill.';
/**
 * LOCAL-channel priority-and-fallback prose. Remote documents no longer emit
 * an online-MCP fallback ladder from this block — only their dynamic inventory.
 */
function buildLocalChannelPriorityAndFallback(localMode = 'mcp') {
    const lines = [
        '### Priority & fallback',
        'For all content work (reading, editing, summarizing, translating, creating, etc.) on local documents, ' +
            'invoke the `office-docs-routing` skill. ' +
            'It takes priority over ALL other tools and handles MCP tool selection and batch operations internally.',
    ];
    if (localMode === 'mcp') {
        lines.push('Only after the skill is unavailable or reports a concrete failure may you fall back to calling ' +
            'local Office Docs MCP tools directly. If direct MCP also fails, you may then use other tools ' +
            '(Bash, python, Read, Write, Edit) — you MUST tell the user before doing so.');
    }
    else {
        lines.push('Only after the skill is unavailable or reports a concrete failure may you fall back to driving the ' +
            'local engine yourself using the calling style the `office-local-edit` skill documents. ' +
            'If that also fails, you may then use other tools (Bash, python, Read, Write, Edit) — you MUST tell ' +
            'the user before doing so.');
    }
    return lines;
}
/**
 * Build the "two skills, two roles" note for the LOCAL `skill` channel.
 *
 * Only emitted when {@link LocalChannelMode} is `'skill'` (and on the first
 * routing turn). It names the division of labor so the model does not conflate
 * the two skills it sees in this mode: `office-docs-routing` is the *decision*
 * gate (chooses channel and path), while `office-local-edit` is the
 * *work* skill that owns the local engine's tool catalog, parameter schemas,
 * and calling style. They are NOT interchangeable — one decides what to do, the
 * other knows how to do it. The concrete tool catalog and the `file_id`
 * resolution ladder deliberately stay inside the skill, not here.
 */
function buildLocalSkillToolsAccessNote() {
    return [
        '',
        '## Local Office Docs engine tools',
        'Two skills, two roles — do not conflate them: ' +
            '(a) `office-docs-routing` is the *decision* skill that chooses which channel and path to use; ' +
            '(b) `office-local-edit` is the *work* skill that owns the local Office Docs engine’s ' +
            'tool catalog, parameter schemas, and calling style. ' +
            'When routing selects local-document content work, load `office-local-edit` (and its ' +
            '`doc` / `sheet` / `slide` references) before any tool call, and follow its documented calling style.',
    ];
}
/**
 * Minimal XML attribute escape — kept local so this module has zero
 * dependencies on host-side utility files. Matches the same 4-char escape
 * surface (`& " < >`) as the jugglework-desktop `xml.ts` helper.
 */
function escapeXmlAttribute(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
//# sourceMappingURL=routing-prompt.js.map