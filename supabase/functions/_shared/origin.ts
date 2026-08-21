export const productionOrigin = 'https://sequencemath.co.kr';

export function isAllowedOrigin(origin: string) {
  try {
    const url = new URL(origin);
    if (url.origin !== origin) return false;
    const { hostname } = url;
    const previewSuffix = '.we-math.pages.dev';
    const previewLabels = hostname.endsWith(previewSuffix) ? hostname.slice(0, -previewSuffix.length).split('.') : [];
    const ownedPreview = previewLabels.length > 0 && previewLabels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
    const ownedPages = url.protocol === 'https:' && (hostname === 'we-math.pages.dev' || ownedPreview);
    const primarySite = url.protocol === 'https:' && hostname === 'sequencemath.co.kr';
    const localDev = ['localhost', '127.0.0.1'].includes(hostname) && ['http:', 'https:'].includes(url.protocol);
    return primarySite || ownedPages || localDev;
  } catch { return false; }
}
