/*
 * OLX Ad Blocker — service worker.
 * Seeds default settings and mirrors the hidden-ad count onto the toolbar badge.
 * Network-level ad blocking is done by declarativeNetRequest static rules
 * (rules/ad-rules.json) declared in the manifest.
 */
'use strict';

const DEFAULTS = {
  enabled: true,
  hidePaidListings: true,
  hideAdSlots: true,
  hidePromoTiles: true
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULTS, (current) => {
    const toSeed = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (!(key in current)) toSeed[key] = DEFAULTS[key];
    }
    if (Object.keys(toSeed).length) chrome.storage.sync.set(toSeed);
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'olx-adblocker-count' && sender.tab && sender.tab.id != null) {
    const text = msg.count > 0 ? String(msg.count) : '';
    try {
      chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#c5221f' });
      chrome.action.setBadgeText({ tabId: sender.tab.id, text });
    } catch (e) { /* tab may be gone */ }
  }
});
