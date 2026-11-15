# Offline emergency card: manual test checklist

Synthetic data only. Use a demo patient from the patient portal.

## Setup

1. Start Medistry: `npm start` (or use the deployed demo). The scanner needs a secure context for the
   camera and the service worker: `https://…`, or `http://localhost` on the same machine.
   To test with a phone against a laptop, deploy, or use an HTTPS tunnel.
2. Patient portal → choose a patient → **Emergency kit** → **My emergency card** → **Print card**
   (or open `/emergency/offline-card?patientId=…`). Print it, or show it on a second screen.

## Checklist

| # | Step | Expected |
|---|---|---|
| 1 | Open `/s` while online. Wait until the indicator says **Online**. | Scanner page loads. The service worker installs in the background. |
| 2 | Turn on airplane mode (or stop the server). | Indicator switches to **Offline**. |
| 3 | Reload `/s`. | The page still loads, from the service worker cache. |
| 4 | Tap **Scan with camera** and scan the printed card. | **GENUINE CARD**: blood group and genotype on top, severe allergies in red, DNR banner if set, opt-in items, emergency contact with a call button, and "Card v{n}, issued {date}, verified offline". |
| 5 | Copy the card link, change one character of the token, paste it and press **Verify**. | Full red screen: **CARD NOT GENUINE: do not rely on this data**. No medical data is shown. |

## Extra checks

- Open the card link (`…/s#<token>`) with the phone's normal camera app: the result appears and the
  `#token` part disappears from the address bar and from history.
- Expired card (set `OFFLINE_CARD_VALIDITY_DAYS=1`, issue a card, then set the device date 2 days ahead):
  amber **Card expired on {date}**, data marked **UNVERIFIED-CURRENT**.
- Card signed by a key this device has never seen (restart a dev server without `OFFLINE_CARD_PRIVATE_KEY`,
  issue a card, scan offline on a device that cached the old keys): **Cannot verify: connect once to update keys**.
  Go online and scan again: it verifies.
- Device language Swahili: scanner strings appear in Swahili.
- Browser without `BarcodeDetector` (for example iOS Safari, desktop Firefox): camera scanning uses the vendored jsQR.

## Known limits

- Offline verification proves the card was issued by Medistry and is unexpired. It cannot tell whether
  the card was later superseded or revoked.
- The QR is signed, not encrypted: anyone who decodes it can read what the patient chose to include.
- The first visit must be online, and after a deployment that changes scanner files the page updates only
  when `CACHE_VERSION` in `site/sw.js` is bumped.

## Results log

| Date | Who | Device / browser | Steps passed | Notes |
|---|---|---|---|---|
| 2026-11-15 | Claude (automated, headless Chrome over DevTools, phone-size viewport) | Chrome desktop, headless, http://localhost | 1, 2, 3, 4, 5 | Offline = server stopped and browser network emulated offline. Step 4 used the card's QR link (fresh open and same-tab) instead of a camera; camera scanning, BarcodeDetector and jsQR were not exercised. Real phones not tested. |
