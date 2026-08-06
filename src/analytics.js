const ATTRIBUTION_KEY = 'sequence_initial_attribution';
const DEFAULT_MEASUREMENT_ID = 'G-BXMYNFJFZ8';
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];
const GA_ID_PATTERN = /^G-[A-Z0-9]+$/;

export function captureInitialAttribution({ href, storage }) {
  if (!storage) return {};

  try {
    const existing = storage.getItem(ATTRIBUTION_KEY);
    if (existing) return JSON.parse(existing);

    const params = new URL(href).searchParams;
    const attribution = Object.fromEntries(
      UTM_KEYS.filter((key) => params.has(key)).map((key) => [key, params.get(key)]),
    );
    if (Object.keys(attribution).length) {
      storage.setItem(ATTRIBUTION_KEY, JSON.stringify(attribution));
    }
    return attribution;
  } catch {
    return {};
  }
}

export function initAnalytics({ measurementId, windowObj, documentObj }) {
  captureInitialAttribution({
    href: windowObj?.location?.href ?? '',
    storage: windowObj?.sessionStorage,
  });

  if (!GA_ID_PATTERN.test(measurementId ?? '') || !windowObj || !documentObj) return false;
  if (documentObj.querySelector(`[data-sequence-analytics="${measurementId}"]`)) return true;

  const script = documentObj.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  script.dataset.sequenceAnalytics = measurementId;
  documentObj.head.append(script);

  windowObj.dataLayer = windowObj.dataLayer || [];
  const gtag = (...args) => windowObj.dataLayer.push(args);
  gtag('js', new Date());
  gtag('config', measurementId);
  return true;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  initAnalytics({
    measurementId: import.meta.env.VITE_GA_MEASUREMENT_ID || DEFAULT_MEASUREMENT_ID,
    windowObj: window,
    documentObj: document,
  });
}
