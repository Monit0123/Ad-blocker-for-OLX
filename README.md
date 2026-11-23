# Ad-blocker-for-OLX

A Manifest V3 Chrome extension that hides **all paid ads on [olx.in](https://www.olx.in)** —
including listings labeled **ELITE** (Elite Seller), **Featured**, **Sponsored** and
**promoted** (`search_reason=promoted`) placements — plus third-party banner ad slots.

## Features

- 🚫 **Hides paid listing cards** everywhere on olx.in: home feed, category pages, search
  results, "load more"/infinite scroll, and "similar ads" on item pages.
  - **ELITE** badge (Elite Seller listings — detected via the elite badge icon/alt text
    *and* the `elite_seller` flag in OLX's own search API responses)
  - **FEATURED** badge (`data-testid="adCard-featured"`, badge text)
  - **Sponsored / promoted** cards (`search_reason=...promoted` in the card URL,
    `promoted`/`is_promoted` API flags)
  - **Boost-to-top** paid packages (`btt_package_id` in API data)
- 🖼️ **Hides banner ad slots**: Google DFP/"baxter" containers, `div-gpt-ad` slots, ad
  iframes (doubleclick, googlesyndication, …), `advertisement`/`ad-slot` wrappers.
- 📢 **Hides OLX promo/upsell tiles** inside the results feed (optional).
- 🌐 **Blocks ad-network requests** at the network level via `declarativeNetRequest`
  (doubleclick.net, googlesyndication.com, googleadservices.com, ad(s).olx.in, etc.),
  only when initiated from olx.in pages.
- 🔢 **Toolbar badge** shows how many ads were hidden on the current page.
- ⚙️ **Popup controls**: master switch + independent toggles for paid listings, ad slots
  and promo tiles (synced via `chrome.storage.sync`, applied live without reload).
- 🛡️ The listing you open yourself is never hidden (item detail pages keep their content;
  only paid *related* cards there are removed). Your own "My Ads"/chat/sell pages are untouched.

## Install (developer mode)

1. Clone/download this repository.
2. Open `chrome://extensions` in Chrome (or any Chromium browser: Edge, Brave, …).
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this repository folder.
5. Visit [olx.in](https://www.olx.in) — paid/Elite/Featured listings disappear.
   The toolbar icon shows the number of hidden ads and opens the settings popup.

## How it works

| Layer | File | Role |
| --- | --- | --- |
| Page world | `inject.js` | Hooks `fetch`/`XHR`, reads OLX's own `/api/...` JSON responses and forwards ad IDs flagged paid (`elite_seller`, `featured`/`is_featured`, `promoted`/`is_promoted`, `btt_package_id`, `search_reason=promoted`) to the content script via `postMessage`. |
| Content script | `content.js` | Scans the DOM (MutationObserver + periodic rescan), flags paid listing cards (`[data-cy="l-card"]` / `[data-testid="l-card"]` and fallbacks) using badge text, `adCard-*` test ids, elite icon images, promoted hrefs and API-flagged IDs, then hides them. Also hides ad slots and promo tiles. |
| Styles | `content.css` | `.olx-adblock-hidden { display:none !important; … }` |
| Network | `rules/ad-rules.json` | Static `declarativeNetRequest` block rules for ad domains, initiated only from `olx.in`. |
| Background | `background.js` | Seeds default settings, mirrors the hidden count onto the toolbar badge. |
| Popup | `popup/` | Settings UI + live "hidden on this page" counter. |

Detection is intentionally multi-signal so it keeps working when OLX changes a single
class name: badges, `data-testid`/`data-cy` attributes, icon URLs, URL markers and the
site's own API flags are all cross-checked.

## Permissions

- `storage` — remember your toggle settings.
- `declarativeNetRequest` + host access to `*://*.olx.in/*` — block ad-network requests
  and run the content scripts on olx.in only. No data leaves your browser.

## Tests

A jsdom-based test suite (mock olx.in results page + item page) verifies the hiding logic:

```bash
cd tests
npm install
npm test
```

## Notes / limitations

- OLX ships results as React SPA with infinite scroll; the extension re-scans on DOM
  mutations, so newly loaded paid listings are hidden automatically.
- If OLX changes its markup, the API-flag hook (`elite_seller` etc.) is the most stable
  signal and keeps working independently of DOM changes.
- Only `olx.in` is affected; other sites are untouched.
