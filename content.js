/*
 * OLX Ad Blocker — content script (isolated world), runs on *.olx.in
 *
 * Hides:
 *   1. Paid listing cards: Elite (Elite Seller), Featured, Sponsored,
 *      promoted (search_reason=promoted) and boost-to-top listings.
 *   2. Third-party banner ad slots (Google DFP / "baxter" slots, ad iframes).
 *   3. OLX promo / "upsell" tiles inside the results feed.
 *
 * Detection combines DOM signals (badges, data-testid="adCard-*", elite icon
 * images, promoted hrefs) with ad IDs collected from OLX's own search API
 * (injected into the page by inject.js, passed via postMessage).
 */
(() => {
  'use strict';

  const HIDE_CLASS = 'olx-adblock-hidden';

  // Listing card containers used by OLX's React app (plus generic fallbacks).
  const CARD_ATTR_SELECTOR = '[data-cy="l-card"], [data-testid="l-card"]';
  const CARD_FALLBACK_SELECTOR = 'li, article';
  const ITEM_LINK = 'a[href*="/item/"]';

  // Short standalone badges OLX renders on paid cards.
  const BADGE_RE = /^(elite|featured|sponsored|promoted|advertisement|ad)$/i;
  const BADGE_TAGS = 'span, p, div, strong, em, small, h6, a';
  // Title-ish elements whose text must never be treated as a badge.
  const TITLE_EL_SELECTOR = 'h1, h2, h3, h4, h5, [data-testid="card-title-link"], [data-testid="listing-ad-title"]';

  // Pages where we must not hide listing cards (own ads / chat / posting flow).
  const SKIP_PATH_RE = /^\/(myads|my-ads|chat|inbox|chats|sell|post|myolx)/i;

  const DEFAULTS = {
    enabled: true,
    hidePaidListings: true, // Elite / Featured / Sponsored / promoted listing cards
    hideAdSlots: true,      // banner ad slots, DFP containers, ad iframes
    hidePromoTiles: true    // OLX "upsell"/promo tiles inside the feed
  };

  let settings = { ...DEFAULTS };
  const apiPaidIds = new Set(); // ad ids flagged as paid by OLX's own API responses
  let hiddenCount = 0;
  let scanTimer = null;
  let lastReported = -1;

  // ---------------------------------------------------------------- settings
  function loadSettings() {
    try {
      chrome.storage.sync.get(DEFAULTS, (res) => {
        settings = { ...DEFAULTS, ...(res || {}) };
        applySettings();
        scheduleScan();
      });
    } catch (e) {
      applySettings();
      scheduleScan();
    }
  }

  function applySettings() {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle('olx-ab-on', !!settings.enabled);
    root.classList.toggle('olx-ab-listings-on', !!settings.enabled && !!settings.hidePaidListings);
    root.classList.toggle('olx-ab-slots-on', !!settings.enabled && !!settings.hideAdSlots);
    root.classList.toggle('olx-ab-promo-on', !!settings.enabled && !!settings.hidePromoTiles);
    if (!settings.enabled) unhideAll();
  }

  function unhideAll() {
    document.querySelectorAll('.' + HIDE_CLASS).forEach((el) => el.classList.remove(HIDE_CLASS));
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      let changed = false;
      for (const k of Object.keys(DEFAULTS)) {
        if (k in changes) {
          settings[k] = changes[k].newValue;
          changed = true;
        }
      }
      if (changed) {
        unhideAll();
        applySettings();
        scheduleScan();
      }
    });
  } catch (e) { /* storage unavailable (tests) */ }

  // ------------------------------------------------------- paid-card checks
  function directText(el) {
    let t = '';
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
    }
    return t.trim().replace(/\s+/g, ' ');
  }

  function hrefHasPromoted(a) {
    const href = a.getAttribute('href') || '';
    return /search_reason=[^&"'<>]*promoted/i.test(href);
  }

  function hrefAdId(a) {
    const m = (a.getAttribute('href') || '').match(/iid-(\d+)/);
    return m ? m[1] : null;
  }

  function isCurrentListing(card) {
    // Never hide the listing whose detail page we are currently on.
    const path = location.pathname;
    return Array.from(card.querySelectorAll(ITEM_LINK)).some((a) => {
      try {
        return new URL(a.getAttribute('href'), location.href).pathname === path;
      } catch (e) {
        return false;
      }
    });
  }

  function isPaidCard(card) {
    if (isCurrentListing(card)) return false;
    // On a listing detail page, only touch cards that actually link to a
    // listing (related/"similar ads" cards) — never the main detail block,
    // which also carries FEATURED/ELITE badges for the opened ad itself.
    if (location.pathname.startsWith('/item/') && !card.querySelector(ITEM_LINK)) return false;

    // 1. OLX paid-card namespaced test ids: adCard-featured, adCard-promoted, ...
    if (card.querySelector('[data-testid^="adCard-"], [data-cy^="adCard-"]')) return true;

    // 2. Promoted marker in the card link, or an ad id flagged by the API hook.
    const links = card.querySelectorAll(ITEM_LINK);
    for (const a of links) {
      if (hrefHasPromoted(a)) return true;
      const id = hrefAdId(a);
      if (id && apiPaidIds.has(id)) return true;
    }

    // 3. Elite badge artwork (alt text / icon URL / test id) — case-insensitive manual checks.
    for (const img of card.querySelectorAll('img')) {
      const alt = (img.getAttribute('alt') || '').toLowerCase();
      const src = (img.getAttribute('src') || '').toLowerCase();
      if (alt.includes('elite') || src.includes('elite-tag-icon') || src.includes('elite-seller-tag')) return true;
    }
    for (const el of card.querySelectorAll('[data-testid], [data-cy]')) {
      const t = ((el.getAttribute('data-testid') || '') + ' ' + (el.getAttribute('data-cy') || '')).toLowerCase();
      if (t.includes('elite')) return true;
    }

    // 4. Short standalone text badge: ELITE / FEATURED / SPONSORED / AD ...
    for (const el of card.querySelectorAll(BADGE_TAGS)) {
      if (el.matches(TITLE_EL_SELECTOR)) continue;
      if (el.querySelector(ITEM_LINK)) continue; // container, not a leaf badge
      const t = directText(el);
      if (t && t.length <= 20 && BADGE_RE.test(t)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ ad slot scan
  const AD_HOST_RE = /doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google|google-analytics\.com\/.*ads|ad(s)?\.olx\.in|baxter\.olx\.in|amazon-adsystem\.com|ads\.pubmatic\.com|criteo\.(com|net)|rubiconproject\.com|openx\.net|taboola\.com|outbrain\.com|mgid\.com|smartadserver\.com|adform\.net/i;
  const AD_CLASS_RE = /baxter|dfp|gpt-ad|advertisement|ad-slot|ad-banner|ad-container|ad-wrapper|google-ad/i;

  function isAdSlot(el) {
    if (el.tagName === 'IFRAME' || el.tagName === 'INS' || el.tagName === 'SCRIPT') {
      const s = el.getAttribute('src') || '';
      if (AD_HOST_RE.test(s)) return true;
    }
    const cls = typeof el.className === 'string' ? el.className : '';
    if (AD_CLASS_RE.test(cls)) return true;
    if (el.id && /gpt-ad|ad-slot|advert/i.test(el.id)) return true;
    const aria = el.getAttribute('aria-label') || '';
    if (/advertisement|sponsored/i.test(aria)) return true;
    const style = (el.getAttribute('style') || '').replace(/\s/g, '');
    if (style === 'min-height:120px;display:block;') return true; // known OLX DFP placeholder
    return false;
  }

  function hideAdSlot(el) {
    // For baxter/DFP markers hide the wrapper too (the visible ad container).
    const cls = typeof el.className === 'string' ? el.className : '';
    let target = el;
    if (/baxter|dfp|gpt-ad/i.test(cls) && el.parentElement) target = el.parentElement;
    if (!target.classList.contains(HIDE_CLASS)) {
      target.classList.add(HIDE_CLASS);
      hiddenCount++;
    }
  }

  // ------------------------------------------------------------- card lookup
  function findCard(el) {
    let node = el.closest(CARD_ATTR_SELECTOR);
    if (node) return node;
    let p = el.parentElement;
    let depth = 0;
    while (p && depth < 8 && p !== document.body) {
      if (p.matches(CARD_ATTR_SELECTOR + ', ' + CARD_FALLBACK_SELECTOR)) return p;
      // a wrapper whose children include an item link is card-like
      let hasLink = false;
      for (const c of p.children) {
        if (c.matches(ITEM_LINK) || (c.querySelector && c.querySelector(ITEM_LINK))) { hasLink = true; break; }
      }
      if (hasLink && p.children.length <= 4) return p;
      p = p.parentElement;
      depth++;
    }
    return p && p !== document.body ? p : null;
  }

  // ------------------------------------------------------------------- scan
  function scan() {
    if (!settings.enabled) return;
    hiddenCount = 0;

    if (settings.hidePaidListings && !SKIP_PATH_RE.test(location.pathname)) {
      const cards = document.querySelectorAll(CARD_ATTR_SELECTOR + ', ' + CARD_FALLBACK_SELECTOR);
      for (const card of cards) {
        if (card.classList.contains(HIDE_CLASS)) { hiddenCount++; continue; }
        if (isPaidCard(card)) {
          card.classList.add(HIDE_CLASS);
          hiddenCount++;
        }
      }
      // Catch cards not using the known attributes (anchors first).
      for (const a of document.querySelectorAll(ITEM_LINK)) {
        const card = findCard(a);
        if (card && !card.classList.contains(HIDE_CLASS) && isPaidCard(card)) {
          card.classList.add(HIDE_CLASS);
          hiddenCount++;
        }
      }
    }

    if (settings.hideAdSlots) {
      const candidates = document.querySelectorAll(
        '[class*="baxter"], [class*="dfp"], [class*="gpt"], [id*="gpt-ad"], [class*="ad-"], iframe, ins, [aria-label*="dvertisement"], [aria-label*="ponsored"]'
      );
      for (const el of candidates) {
        if (el.closest('.' + HIDE_CLASS)) continue;
        if (isAdSlot(el)) hideAdSlot(el);
      }
    }

    if (settings.hidePromoTiles) {
      for (const img of document.querySelectorAll('img')) {
        const src = (img.getAttribute('src') || '').toLowerCase();
        const alt = (img.getAttribute('alt') || '').toLowerCase();
        if (!src.includes('upsell') && !alt.includes('upsell')) continue;
        const tile = findCard(img);
        if (tile && !tile.classList.contains(HIDE_CLASS)) {
          tile.classList.add(HIDE_CLASS);
          hiddenCount++;
        }
      }
    }

    reportCount();
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 120);
  }

  // ------------------------------------------------------------- reporting
  function reportCount() {
    if (hiddenCount === lastReported) return;
    lastReported = hiddenCount;
    try {
      chrome.runtime.sendMessage({ type: 'olx-adblocker-count', count: hiddenCount });
    } catch (e) { /* extension context gone */ }
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'olx-adblocker-get-count') {
        sendResponse({ count: hiddenCount, settings: { ...settings } });
      }
      return true;
    });
  } catch (e) { /* tests */ }

  // IDs flagged as paid by OLX's own search API (see inject.js).
  window.addEventListener('message', (ev) => {
    if (ev.source && ev.source !== window) return;
    const d = ev.data;
    if (d && d.type === 'OLX_ADBLOCKER_PAID_IDS' && Array.isArray(d.ids)) {
      for (const id of d.ids) apiPaidIds.add(String(id));
      scheduleScan();
    }
  });

  // ------------------------------------------------------------------ boot
  function boot() {
    loadSettings();
    if (document.documentElement) {
      const observer = new MutationObserver(() => scheduleScan());
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    // Periodic rescan: React can re-render and drop our class.
    setInterval(scheduleScan, 2000);
    scheduleScan();
  }

  if (document.documentElement) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
