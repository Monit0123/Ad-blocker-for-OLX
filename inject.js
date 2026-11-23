/*
 * OLX Ad Blocker — page-world (MAIN) script.
 *
 * OLX's web app loads results from its own JSON API (e.g. /api/search).
 * Every listing object there carries paid flags such as `elite_seller`,
 * `is_featured`/`featured`, `promoted`/`is_promoted`, `fixed_on_top`,
 * `btt_package_id` (boost-to-top) or a `search_reason=...promoted` URL.
 *
 * This script hooks fetch/XHR, reads those responses and forwards the paid
 * ad ids to the content script via postMessage. The content script then
 * hides any card linking to iid-<id>.
 */
(() => {
  'use strict';

  const MAX_NODES = 20000;

  function flagsPaid(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    if (item.elite_seller === true) return true;
    if (item.is_featured === true || item.featured === true) return true;
    if (item.is_promoted === true || item.promoted === true) return true;
    if (item.fixed_on_top === true) return true;
    if (item.btt_package_id || item.boost_package_id || item.package_id) return true;
    const u = item.url || item.href || item.link || '';
    if (typeof u === 'string' && /search_reason=[^&"']*promoted/i.test(u)) return true;
    return false;
  }

  function idOf(item) {
    const id = item.ad_id ?? item.id ?? item.list_id ?? item.listId;
    return id !== undefined && id !== null && id !== '' ? String(id) : '';
  }

  function walk(obj, out, depth, counter) {
    if (!obj || typeof obj !== 'object' || counter.n > MAX_NODES) return;
    if (Array.isArray(obj)) {
      for (const o of obj) { counter.n++; walk(o, out, depth + 1, counter); }
      return;
    }
    if (depth <= 6 && flagsPaid(obj)) {
      const id = idOf(obj);
      if (id) out.push(id);
    }
    if (depth >= 8) return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object') { counter.n++; walk(v, out, depth + 1, counter); }
    }
  }

  function extractPaidIds(json) {
    const out = [];
    walk(json, out, 0, { n: 0 });
    return out;
  }

  function send(ids) {
    if (ids && ids.length) {
      try { window.postMessage({ type: 'OLX_ADBLOCKER_PAID_IDS', ids }, '*'); } catch (e) {}
    }
  }

  function isApiUrl(url) {
    return typeof url === 'string' && (url.includes('/api/') || /olx\.in\/api/i.test(url));
  }

  // Exposed for debugging/tests.
  try { window.__olxAdblockerExtractPaidIds = extractPaidIds; } catch (e) {}

  // ---- hook fetch ----
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      const p = origFetch.apply(this, args);
      if (isApiUrl(url)) {
        p.then((res) => {
          try {
            res.clone().text().then((txt) => {
              try { send(extractPaidIds(JSON.parse(txt))); } catch (e) {}
            }).catch(() => {});
          } catch (e) {}
        }).catch(() => {});
      }
      return p;
    };
  }

  // ---- hook XHR ----
  if (typeof window.XMLHttpRequest === 'function') {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__olxAbUrl = String(url);
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      if (isApiUrl(this.__olxAbUrl || '')) {
        this.addEventListener('load', () => {
          try { send(extractPaidIds(JSON.parse(this.responseText))); } catch (e) {}
        });
      }
      return origSend.apply(this, args);
    };
  }
})();
