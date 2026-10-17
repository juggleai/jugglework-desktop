"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TENCENT_DOCS_PREVIEW_LOCALE = void 0;
exports.resolveTencentDocsPreviewLocale = resolveTencentDocsPreviewLocale;
exports.isTencentDocsLocalSdkPreviewUrl = isTencentDocsLocalSdkPreviewUrl;
exports.appendTencentDocsLocalSdkPreviewParams = appendTencentDocsLocalSdkPreviewParams;
exports.buildTencentDocsPreviewThemeMessage = buildTencentDocsPreviewThemeMessage;
exports.buildTencentDocsPreviewLocaleMessage = buildTencentDocsPreviewLocaleMessage;
exports.DEFAULT_TENCENT_DOCS_PREVIEW_LOCALE = 'zh-CN';
const TENCENT_DOCS_PREVIEW_LOCALE_BY_APP_LOCALE = {
    zh: 'zh-CN',
    'zh-cn': 'zh-CN',
    en: 'en-US',
    'en-us': 'en-US',
};
const TENCENT_DOCS_LOCAL_SDK_PREVIEW_PATH_PATTERN = /^\/static\/(?:doc|sheet|slide|pdf)\/pc\.html$/;
function resolveTencentDocsPreviewLocale(locale) {
    const normalizedLocale = locale?.trim().toLowerCase();
    if (!normalizedLocale) {
        return exports.DEFAULT_TENCENT_DOCS_PREVIEW_LOCALE;
    }
    return (TENCENT_DOCS_PREVIEW_LOCALE_BY_APP_LOCALE[normalizedLocale] ??
        exports.DEFAULT_TENCENT_DOCS_PREVIEW_LOCALE);
}
function isTencentDocsLocalSdkPreviewUrl(value) {
    try {
        const url = typeof value === 'string' ? new URL(value) : value;
        return (url.protocol === 'http:' &&
            (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
            TENCENT_DOCS_LOCAL_SDK_PREVIEW_PATH_PATTERN.test(url.pathname));
    }
    catch {
        return false;
    }
}
function appendTencentDocsLocalSdkPreviewParams(src, params) {
    try {
        const url = new URL(src);
        if (!isTencentDocsLocalSdkPreviewUrl(url)) {
            return src;
        }
        if (params.theme) {
            url.searchParams.set('theme', params.theme);
            url.searchParams.set('colorScheme', params.theme);
            url.searchParams.set('workbuddyTheme', params.theme);
        }
        if (params.locale) {
            url.searchParams.set('lng', params.locale);
        }
        return url.toString();
    }
    catch {
        return src;
    }
}
function buildTencentDocsPreviewThemeMessage(theme) {
    return {
        type: 'workbuddy:themeChanged',
        theme,
        colorScheme: theme,
        shouldUseDarkColors: theme === 'dark',
    };
}
function buildTencentDocsPreviewLocaleMessage(locale) {
    return {
        type: 'workbuddy:localeChanged',
        locale,
        language: locale,
        lng: locale,
    };
}
//# sourceMappingURL=preview-runtime.js.map