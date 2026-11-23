/*
 * jsdom-based tests for the OLX Ad Blocker extension.
 * Loads tests/fixture.html (a mock olx.in results page), evals the real
 * inject.js + content.js inside the jsdom window with a mocked chrome API,
 * and asserts that paid/elite/featured/promoted cards and ad slots get hidden.
 *
 * Run: npm install && npm test   (inside tests/)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const fixtureHtml = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');
const contentCss = fs.readFileSync(path.join(ROOT, 'content.css'), 'utf8');
const contentJs = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const injectJs = fs.readFileSync(path.join(ROOT, 'inject.js'), 'utf8');

const html = fixtureHtml.replace('</head>', `<style>${contentCss}</style></head>`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    console.error(`  FAIL - ${name}`);
  }
}

function makeChromeMock() {
  const listeners = { storageChanged: [], msg: [] };
  const sent = [];
  const store = {};
  const chrome = {
    storage: {
      sync: {
        get: (defaults, cb) => cb({ ...defaults, ...store }),
        set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); }
      },
      onChanged: { addListener: (fn) => listeners.storageChanged.push(fn) }
    },
    runtime: {
      sendMessage: (msg) => sent.push(msg),
      onMessage: { addListener: (fn) => listeners.msg.push(fn) }
    }
  };
  return { chrome, listeners, sent, store };
}

function boot(url, htmlOverride) {
  const dom = new JSDOM(htmlOverride || html, {
    url: url || 'https://www.olx.in/cars_c84?q=honda',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const mock = makeChromeMock();
  window.chrome = mock.chrome;

  // fake fetch so inject.js installs its hook on something
  const apiResponse = JSON.stringify({
    data: [{ ad_id: '4001', elite_seller: true, title: 'Elite dealer car' }]
  });
  window.fetch = async (url) => ({
    clone: () => ({ text: async () => apiResponse })
  });

  const posted = [];
  window.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'OLX_ADBLOCKER_PAID_IDS') posted.push(...ev.data.ids);
  });

  window.eval(injectJs);
  window.eval(contentJs);
  return { window, mock, posted };
}

(async () => {
  console.log('OLX Ad Blocker — content script tests');
  const { window, mock, posted } = boot();
  const { document } = window;
  await sleep(400); // initial debounced scan

  const hidden = (id) => document.getElementById(id).classList.contains('olx-adblock-hidden');
  const visible = (id) => !hidden(id);

  console.log('\n[1] initial page scan');
  assert(hidden('c-featured-testid'), 'card with data-testid="adCard-featured" is hidden');
  assert(hidden('c-featured-text'), 'card with "FEATURED" badge text is hidden');
  assert(hidden('c-elite-img'), 'card with ELITE badge image is hidden');
  assert(hidden('c-promoted-href'), 'card with search_reason=...promoted href is hidden');
  assert(visible('c-organic'), 'organic listing stays visible');
  assert(visible('c-organic-2'), 'second organic listing stays visible');
  assert(visible('c-api-id'), 'unflagged card visible before API message');
  assert(hidden('upsell-tile'), 'upsell promo tile is hidden');
  assert(hidden('ad-slot-wrapper'), 'baxter DFP ad slot (wrapper) is hidden');
  assert(hidden('ad-iframe'), 'doubleclick ad iframe is hidden');
  assert(
    window.getComputedStyle(document.getElementById('c-featured-testid')).display === 'none',
    'hidden card has computed display:none (CSS applied)'
  );

  const countMsg = mock.sent.filter((m) => m.type === 'olx-adblocker-count').pop();
  assert(countMsg && countMsg.count === 7, `hidden count reported to badge = 7 (got ${countMsg && countMsg.count})`);

  console.log('\n[2] API hook (elite_seller flag) via postMessage');
  window.postMessage({ type: 'OLX_ADBLOCKER_PAID_IDS', ids: ['1006'] }, '*');
  await sleep(400);
  assert(hidden('c-api-id'), 'card hidden after its iid was flagged paid by OLX API data');
  assert(visible('c-organic'), 'organic listing still visible');

  console.log('\n[3] inject.js extractPaidIds + fetch hook');
  const extract = window.__olxAdblockerExtractPaidIds;
  assert(typeof extract === 'function', 'extractPaidIds exposed');
  const ids = extract({
    data: [
      { ad_id: '3001', elite_seller: true },
      { ad_id: '3002', elite_seller: false, btt_package_id: '999' },
      { ad_id: '3003', is_featured: true },
      { ad_id: '3004', url: '/item/x-iid-3004?search_reason=search%7Cpromoted' },
      { ad_id: '3005', elite_seller: false, title: 'organic' }
    ]
  });
  for (const id of ['3001', '3002', '3003', '3004']) assert(ids.includes(id), `extractPaidIds flags ${id}`);
  assert(!ids.includes('3005'), 'extractPaidIds ignores organic listing');
  await window.fetch('https://www.olx.in/api/search?q=honda');
  await sleep(50);
  assert(posted.includes('4001'), 'fetch hook forwards paid id from /api/ response');

  console.log('\n[4] dynamic content (infinite scroll)');
  const grid = document.querySelector('[data-testid="listing-grid"]');
  const dyn = document.createElement('div');
  dyn.setAttribute('data-cy', 'l-card');
  dyn.id = 'c-dynamic';
  dyn.innerHTML =
    '<a href="/item/cars-c84-x-iid-2001"><img alt="ELITE" src="https://apollo.olx.in/v1/files/alias-elite-tag-icon-new/image"><h2>Dynamic elite ad</h2></a>' +
    '<p data-testid="ad-price">₹ 9,99,999</p>';
  grid.appendChild(dyn);
  await sleep(500);
  assert(hidden('c-dynamic'), 'dynamically added ELITE card hidden by MutationObserver');

  console.log('\n[5] item detail page: own listing never hidden, paid related ads are');
  const itemHtml = `<!doctype html><html><head></head><body>
    <article id="main-listing">
      <a href="/item/cars-c84-honda-city-ludhiana-iid-9999"><h1>Honda City 2019</h1></a>
      <img alt="ELITE" src="https://apollo.olx.in/v1/files/alias-elite-tag-icon-new/image;original=true">
      <span>FEATURED</span>
      <p data-testid="ad-price">₹ 5,50,000</p>
    </article>
    <div data-testid="listing-grid">
      <div data-cy="l-card" id="rel-elite">
        <a href="/item/cars-c84-related-iid-8888"><img alt="ELITE" src="https://apollo.olx.in/v1/files/alias-elite-tag-icon-new/image"><h2>Related elite</h2></a>
      </div>
      <div data-cy="l-card" id="rel-organic">
        <a href="/item/cars-c84-related-iid-8889"><h2>Related organic</h2></a>
      </div>
    </div>
  </body></html>`.replace('</head>', `<style>${contentCss}</style></head>`);
  const item = boot('https://www.olx.in/item/cars-c84-honda-city-ludhiana-iid-9999', itemHtml);
  await sleep(400);
  const idoc = item.window.document;
  assert(
    !idoc.getElementById('main-listing').classList.contains('olx-adblock-hidden'),
    'main listing on its own detail page is NOT hidden despite FEATURED/ELITE badges'
  );
  assert(
    idoc.getElementById('rel-elite').classList.contains('olx-adblock-hidden'),
    'paid (elite) related card on item page IS hidden'
  );
  assert(
    !idoc.getElementById('rel-organic').classList.contains('olx-adblock-hidden'),
    'organic related card on item page stays visible'
  );

  console.log('\n[6] settings toggles');
  mock.listeners.storageChanged.forEach((fn) => fn({ enabled: { newValue: false } }, 'sync'));
  await sleep(400);
  assert(
    visible('c-featured-testid') && visible('c-elite-img') && visible('ad-iframe'),
    'master switch OFF unhides everything'
  );
  assert(!document.documentElement.classList.contains('olx-ab-on'), 'html.olx-ab-on removed when disabled');

  mock.listeners.storageChanged.forEach((fn) => fn(
    { enabled: { newValue: true }, hidePaidListings: { newValue: false } }, 'sync'
  ));
  await sleep(400);
  assert(visible('c-featured-testid') && visible('c-elite-img'), 'hidePaidListings OFF → paid cards visible again');
  assert(hidden('ad-iframe') && hidden('ad-slot-wrapper'), 'ad slots still hidden when only listing toggle is off');
  assert(document.documentElement.classList.contains('olx-ab-slots-on'), 'html.olx-ab-slots-on present');
  assert(!document.documentElement.classList.contains('olx-ab-listings-on'), 'html.olx-ab-listings-on absent');

  mock.listeners.storageChanged.forEach((fn) => fn(
    { hidePaidListings: { newValue: true }, hideAdSlots: { newValue: false } }, 'sync'
  ));
  await sleep(400);
  assert(hidden('c-featured-testid'), 'paid listings hidden again after re-enable');
  assert(visible('ad-iframe'), 'hideAdSlots OFF → ad iframes visible again');

  console.log('\n[7] popup count query is answered');
  let queryResp = null;
  mock.listeners.msg.forEach((fn) => fn({ type: 'olx-adblocker-get-count' }, {}, (r) => { queryResp = r; }));
  assert(queryResp && typeof queryResp.count === 'number', `get-count responds with a number (${queryResp && queryResp.count})`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('test harness error:', e);
  process.exit(1);
});
