"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OFFICE_DOCS_ENGINE_SUPPORTED_EXTENSIONS = exports.OFFICE_DOCS_ENGINE_FILE_TYPES = void 0;
exports.getOfficeDocsEngineDocType = getOfficeDocsEngineDocType;
exports.getOfficeDocsSelectionFileType = getOfficeDocsSelectionFileType;
exports.isOfficeDocsEngineSupportedExtension = isOfficeDocsEngineSupportedExtension;
exports.isOfficeDocsEngineDocType = isOfficeDocsEngineDocType;
exports.OFFICE_DOCS_ENGINE_FILE_TYPES = Object.freeze([
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
exports.OFFICE_DOCS_ENGINE_SUPPORTED_EXTENSIONS = Object.freeze(exports.OFFICE_DOCS_ENGINE_FILE_TYPES.flatMap((item) => item.extensions));
const engineDocTypeSet = new Set(exports.OFFICE_DOCS_ENGINE_FILE_TYPES.map((item) => item.engineType));
const extensionToFileType = new Map();
for (const item of exports.OFFICE_DOCS_ENGINE_FILE_TYPES) {
    for (const ext of item.extensions) {
        extensionToFileType.set(ext, item);
    }
}
function normalizeOfficeDocsFileExtension(value) {
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
function getOfficeDocsEngineFileType(value) {
    return extensionToFileType.get(normalizeOfficeDocsFileExtension(value));
}
function getOfficeDocsEngineDocType(value) {
    return getOfficeDocsEngineFileType(value)?.engineType;
}
function getOfficeDocsSelectionFileType(value) {
    return getOfficeDocsEngineFileType(value)?.selectionFileType;
}
function isOfficeDocsEngineSupportedExtension(value) {
    return Boolean(getOfficeDocsEngineFileType(value));
}
function isOfficeDocsEngineDocType(value) {
    return Boolean(value && engineDocTypeSet.has(value));
}
//# sourceMappingURL=document-types.js.map