// resolveDenBaseUrls returns the API root (for example /jwork/api), not /v1.
export function meetingApiUrl(apiBaseUrl: string, path = '') {
  return `${apiBaseUrl.replace(/\/+$/, '')}/v1/meetings${path}`;
}
