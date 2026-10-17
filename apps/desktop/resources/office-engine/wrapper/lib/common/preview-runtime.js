// TIPS: 内嵌页面的固定主题/语言协议字段保持原值，避免名称适配破坏消息兼容。
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_OFFICE_DOCS_PREVIEW_LOCALE = void 0;
exports.resolveOfficeDocsPreviewLocale = resolveOfficeDocsPreviewLocale;
exports.isOfficeDocsLocalSdkPreviewUrl = isOfficeDocsLocalSdkPreviewUrl;
exports.appendOfficeDocsLocalSdkPreviewParams = appendOfficeDocsLocalSdkPreviewParams;
exports.buildOfficeDocsPreviewThemeMessage = buildOfficeDocsPreviewThemeMessage;
exports.buildOfficeDocsPreviewLocaleMessage = buildOfficeDocsPreviewLocaleMessage;
exports.DEFAULT_OFFICE_DOCS_PREVIEW_LOCALE = 'zh-CN';
const OFFICE_DOCS_PREVIEW_LOCALE_BY_APP_LOCALE = {
    zh: 'zh-CN',
    'zh-cn': 'zh-CN',
    en: 'en-US',
    'en-us': 'en-US',
};
const OFFICE_DOCS_LOCAL_SDK_PREVIEW_PATH_PATTERN = /^\/static\/(?:doc|sheet|slide|pdf)\/pc\.html$/;
function resolveOfficeDocsPreviewLocale(locale) {
    const normalizedLocale = locale?.trim().toLowerCase();
    if (!normalizedLocale) {
        return exports.DEFAULT_OFFICE_DOCS_PREVIEW_LOCALE;
    }
    return (OFFICE_DOCS_PREVIEW_LOCALE_BY_APP_LOCALE[normalizedLocale] ??
        exports.DEFAULT_OFFICE_DOCS_PREVIEW_LOCALE);
}
function isOfficeDocsLocalSdkPreviewUrl(value) {
    try {
        const url = typeof value === 'string' ? new URL(value) : value;
        return (url.protocol === 'http:' &&
            (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
            OFFICE_DOCS_LOCAL_SDK_PREVIEW_PATH_PATTERN.test(url.pathname));
    }
    catch {
        return false;
    }
}
function appendOfficeDocsLocalSdkPreviewParams(src, params) {
    try {
        const url = new URL(src);
        if (!isOfficeDocsLocalSdkPreviewUrl(url)) {
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
function buildOfficeDocsPreviewThemeMessage(theme) {
    return {
        type: 'workbuddy:themeChanged',
        theme,
        colorScheme: theme,
        shouldUseDarkColors: theme === 'dark',
    };
}
function buildOfficeDocsPreviewLocaleMessage(locale) {
    return {
        type: 'workbuddy:localeChanged',
        locale,
        language: locale,
        lng: locale,
    };
}
//# sourceMappingURL=preview-runtime.js.map