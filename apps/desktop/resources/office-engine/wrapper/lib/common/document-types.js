"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TENCENT_DOCS_ENGINE_SUPPORTED_EXTENSIONS = exports.TENCENT_DOCS_ENGINE_FILE_TYPES = void 0;
exports.getTencentDocsEngineDocType = getTencentDocsEngineDocType;
exports.getTencentDocsSelectionFileType = getTencentDocsSelectionFileType;
exports.isTencentDocsEngineSupportedExtension = isTencentDocsEngineSupportedExtension;
exports.isTencentDocsEngineDocType = isTencentDocsEngineDocType;
exports.TENCENT_DOCS_ENGINE_FILE_TYPES = Object.freeze([
    Object.freeze({
        engineType: 'doc',
        selectionFileType: 'word',
        extensions: Object.freeze([
            '.doc',
            '.docx',
            '.dot',
            '.dotx',
            '.wps',
            '.wpt',
            '.docm',
            '.dotm',
        ]),
    }),
    Object.freeze({
        engineType: 'sheet',
        selectionFileType: 'excel',
        extensions: Object.freeze(['.csv', '.xls', '.xlsx', '.xlt', '.xltx', '.xlsm', '.xltm']),
    }),
    Object.freeze({
        engineType: 'slide',
        selectionFileType: 'ppt',
        extensions: Object.freeze([
            '.pptx',
            '.ppt',
            '.pps',
            '.pot',
            '.pptm',
            '.ppsx',
            '.ppsm',
            '.potx',
            '.potm',
        ]),
    }),
    Object.freeze({
        engineType: 'pdf',
        selectionFileType: 'pdf',
        extensions: Object.freeze(['.pdf']),
    }),
]);
exports.TENCENT_DOCS_ENGINE_SUPPORTED_EXTENSIONS = Object.freeze(exports.TENCENT_DOCS_ENGINE_FILE_TYPES.flatMap((item) => item.extensions));
const engineDocTypeSet = new Set(exports.TENCENT_DOCS_ENGINE_FILE_TYPES.map((item) => item.engineType));
const extensionToFileType = new Map();
for (const item of exports.TENCENT_DOCS_ENGINE_FILE_TYPES) {
    for (const ext of item.extensions) {
        extensionToFileType.set(ext, item);
    }
}
function normalizeTencentDocsFileExtension(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return '';
    }
    // Bare token with no path separator and no dot (e.g. `docx`): treat the whole
    // token as an extension name. A URL query/fragment can only trail it.
    if (!/[\\/]/.test(trimmed) && !trimmed.includes('.')) {
        const bare = trimmed.split(/[?#]/, 1)[0] ?? '';
        return bare ? `.${bare.toLowerCase()}` : '';
    }
    // Isolate the last path segment first so `#` / `?` inside directory or file
    // names (e.g. `合同_#7#8.docx`) stay literal instead of being mistaken for a
    // URL fragment/query delimiter.
    const slashIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    const fileName = trimmed.slice(slashIndex + 1);
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex < 0 || dotIndex === fileName.length - 1) {
        return '';
    }
    // The extension is the token after the last dot; a URL query/fragment can only
    // trail the extension, so cut at the first `?` / `#` within that token.
    const extToken = fileName.slice(dotIndex + 1).split(/[?#]/, 1)[0] ?? '';
    return extToken ? `.${extToken.toLowerCase()}` : '';
}
function getTencentDocsEngineFileType(value) {
    return extensionToFileType.get(normalizeTencentDocsFileExtension(value));
}
function getTencentDocsEngineDocType(value) {
    return getTencentDocsEngineFileType(value)?.engineType;
}
function getTencentDocsSelectionFileType(value) {
    return getTencentDocsEngineFileType(value)?.selectionFileType;
}
function isTencentDocsEngineSupportedExtension(value) {
    return Boolean(getTencentDocsEngineFileType(value));
}
function isTencentDocsEngineDocType(value) {
    return Boolean(value && engineDocTypeSet.has(value));
}
//# sourceMappingURL=document-types.js.map