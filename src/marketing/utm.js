const ALLOWED_SOURCES = new Set(['naver', 'instagram', 'threads']);
const ALLOWED_MEDIA = new Set(['blog', 'social', 'story']);
const CAMPAIGN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function buildCampaignUrl(targetUrl, { source, medium, campaign, content } = {}) {
  if (!ALLOWED_SOURCES.has(source)) {
    throw new TypeError(`Unsupported UTM source: ${source ?? ''}`);
  }
  if (!ALLOWED_MEDIA.has(medium)) {
    throw new TypeError(`Unsupported UTM medium: ${medium ?? ''}`);
  }
  if (!CAMPAIGN_PATTERN.test(campaign ?? '')) {
    throw new TypeError('UTM campaign must be a lowercase slug');
  }

  const url = new URL(targetUrl);
  url.searchParams.set('utm_source', source);
  url.searchParams.set('utm_medium', medium);
  url.searchParams.set('utm_campaign', campaign);
  if (content) url.searchParams.set('utm_content', content);
  else url.searchParams.delete('utm_content');

  return url.toString();
}
