const stylesheetLinkPattern = (href) => {
  const escapedHref = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<link\\b(?=[^>]*\\brel=["']stylesheet["'])[^>]*\\bhref=["']${escapedHref}["'][^>]*>`, 'i');
};

export const legacyHomepageAssetAliases = Object.freeze({
  'assets/analytics-CCXdMH2W.css': 'analytics.css',
  'assets/analytics-DWUTgIc7.js': 'analytics.js',
  'assets/main-aJufcXEs.js': 'main.js',
  'assets/analytics-B_2EYieq.css': 'analytics.css',
  'assets/analytics-CVS_znIt.js': 'analytics.js',
  'assets/main-CkfseJab.js': 'main.js',
});

export function inlineHomepageCss(html, stylesheetHref, css) {
  const linkPattern = stylesheetLinkPattern(stylesheetHref);
  if (!linkPattern.test(html)) {
    throw new Error(`Homepage stylesheet link not found: ${stylesheetHref}`);
  }

  return html.replace(linkPattern, `<style data-homepage-inline-css>\n${css}\n</style>`);
}

export function findBundleSource(bundle, sourceKind) {
  const output = Object.values(bundle);

  if (sourceKind === 'analytics.css') {
    const asset = output.find((entry) => entry.type === 'asset' && /^assets\/analytics-.*\.css$/.test(entry.fileName));
    return asset?.source;
  }

  const chunkPattern = sourceKind === 'main.js'
    ? /^assets\/main-.*\.js$/
    : /^assets\/analytics-.*\.js$/;
  const chunks = output
    .filter((entry) => entry.type === 'chunk' && chunkPattern.test(entry.fileName))
    .sort((left, right) => right.code.length - left.code.length);
  return chunks[0]?.code;
}

export function homepageAssetResilience() {
  return {
    name: 'homepage-asset-resilience',
    apply: 'build',

    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (context.path !== '/index.html' || !context.bundle) return html;

        const stylesheetHref = html.match(/<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=["']([^"']*\/analytics-[^"']+\.css)["'][^>]*>/i)?.[1];
        if (!stylesheetHref) throw new Error('Built homepage stylesheet link was not found');

        const fileName = stylesheetHref.replace(/^\.\//, '');
        const cssAsset = context.bundle[fileName];
        if (!cssAsset || cssAsset.type !== 'asset') {
          throw new Error(`Built homepage stylesheet asset was not found: ${fileName}`);
        }

        return inlineHomepageCss(html, stylesheetHref, String(cssAsset.source));
      },
    },

    generateBundle(_options, bundle) {
      for (const [legacyFileName, sourceKind] of Object.entries(legacyHomepageAssetAliases)) {
        const source = findBundleSource(bundle, sourceKind);
        if (source === undefined) {
          throw new Error(`Current bundle source was not found for legacy alias: ${sourceKind}`);
        }
        this.emitFile({ type: 'asset', fileName: legacyFileName, source });
      }
    },
  };
}
