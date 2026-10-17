"use strict";
/**
 * User-prompt-side active selection block for Tencent Docs.
 *
 * This is intentionally separate from `routing-prompt.ts`: routing owns document
 * resource routing (`file://...`, `tdoc://...`, file_id, and local vs remote channel), while
 * this block carries only the current document selection payload for tools that
 * can operate on a selected region.
 *
 * In ChatInput the selection is represented as a `tdoc-selection://...`
 * resource_link. The URI identifies the normalized selection/range itself; it
 * is not the document resource URI. Document routing must come from `file://...` /
 * `tdoc://...` document resources or from the host's active document state.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderTencentDocsSelectionPrompt = renderTencentDocsSelectionPrompt;
const NO_ACTIVE_SELECTION_INSTRUCTION = [
    // 只在当前 turn 有 active document 但 chat input 没带 selection chip 时注入；
    // 防止模型复用历史轮次里的旧选区。
    'No selection is active this turn; do not infer one from history.',
].join(' ');
const SELECTION_PAYLOAD_USAGE_INSTRUCTION = [
    // selection_payload 始终是选区 list；user_query 里的 badge 通过 timestamp 绑定到 list item。
    '<selection_payload> is the authoritative selection list for selection-based requests in <user_query>: each @tdoc-selection#<timestamp> maps to the item with the same timestamp; use <user_query> for the requested operation and the matched item for selection arguments.',
].join(' ');
function renderTencentDocsSelectionPrompt(input) {
    const selection = input.activeSelection;
    if (!selection) {
        return [
            '<tencent_docs_selection>',
            NO_ACTIVE_SELECTION_INSTRUCTION,
            '</tencent_docs_selection>',
        ];
    }
    const lines = ['<tencent_docs_selection>'];
    const payloadJson = serializePayload(selection);
    if (payloadJson) {
        lines.push('<selection_payload format="json">', 
        // Hidden context is XML, so JSON must be escaped as text before insertion.
        escapeXmlText(payloadJson), '</selection_payload>', SELECTION_PAYLOAD_USAGE_INSTRUCTION);
    }
    lines.push('</tencent_docs_selection>');
    return lines;
}
function serializePayload(selection) {
    try {
        return JSON.stringify(selection.raw);
    }
    catch {
        return undefined;
    }
}
function escapeXmlText(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
//# sourceMappingURL=selection-prompt.js.map