/* OLX Ad Blocker — popup logic: settings + live hidden-count. */
'use strict';

const KEYS = ['enabled', 'hidePaidListings', 'hideAdSlots', 'hidePromoTiles'];
const DEFAULTS = { enabled: true, hidePaidListings: true, hideAdSlots: true, hidePromoTiles: true };

const els = {};
for (const k of KEYS) els[k] = document.getElementById(k);
const group = document.getElementById('group');
const countEl = document.getElementById('count');

function render(settings) {
  for (const k of KEYS) els[k].checked = !!settings[k];
  group.classList.toggle('disabled', !settings.enabled);
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (res) => render({ ...DEFAULTS, ...(res || {}) }));
}

for (const k of KEYS) {
  els[k].addEventListener('change', () => {
    chrome.storage.sync.set({ [k]: els[k].checked }, () => {
      render({ ...DEFAULTS, ...Object.fromEntries(KEYS.map((x) => [x, els[x].checked])) });
      refreshCount();
    });
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  const next = {};
  for (const k of KEYS) if (k in changes) next[k] = changes[k].newValue;
  if (Object.keys(next).length) {
    chrome.storage.sync.get(DEFAULTS, (res) => render({ ...DEFAULTS, ...(res || {}), ...next }));
  }
});

async function refreshCount() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) { countEl.textContent = '–'; return; }
    if (!/olx\.in/.test(tab.url || '')) { countEl.textContent = 'not an OLX page'; return; }
    chrome.tabs.sendMessage(tab.id, { type: 'olx-adblocker-get-count' }, (resp) => {
      if (chrome.runtime.lastError) { countEl.textContent = '0'; return; }
      countEl.textContent = resp && typeof resp.count === 'number' ? String(resp.count) : '0';
    });
  } catch (e) {
    countEl.textContent = '–';
  }
}

document.getElementById('reload').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) chrome.tabs.reload(tab.id);
    window.close();
  } catch (e) {}
});

load();
refreshCount();
