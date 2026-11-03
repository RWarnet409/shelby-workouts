# web/ — the app

Vanilla HTML/CSS/JS, no build step. Deploy by copying this folder to any static host.

```
web/
  index.html             the one page; three views (Home / Workout / History) plus Session, Exercise, Settings
  app.js                 everything: apiGet/apiPost helpers (docs/SPEC.md §4.3), state, offline queue, views
  styles.css             mobile-first, 44px tap targets, safe-area padding, dark mode via prefers-color-scheme
  config.js              API_URL + TOKEN — copy from config.example.js. Committed in this deploy repo on purpose (GitHub Pages needs it; see docs/SPEC.md §8 in the project folder)
  config.example.js      template for config.js
  program.json           copy of ../data/program.json: phase banners, week notes, cool-downs, and the
                         offline / first-paint copy of the program (the Sheet's Program tab wins once loaded)
  manifest.webmanifest   PWA manifest (docs/SPEC.md §7)
  sw.js                  tiny service worker: network first, cached app shell when offline
  icons/                 icon.svg (source), icon-192.png, icon-512.png, apple-touch-icon.png (180×180 — iOS
                         needs PNG; regenerate the PNGs from the SVG with headless Chrome + System.Drawing)
```

## Run it locally

```bash
python -m http.server 8080      # from this folder, then open http://localhost:8080
```

Browsers block `fetch` of `file://` URLs, so always preview over http. With the placeholder URL still
in `config.js` the app runs from `program.json` and keeps saves on the phone (Home says so). Put the
real `/exec` URL and token in `config.js` and it talks to the Sheet.

## Deploying a change

1. Bump the three version markers together so Safari and the service worker pick up the new files:
   `?v=` on `styles.css` and `app.js` in `index.html`, `VERSION` in `sw.js` (and the two `?v=` entries
   in its `SHELL` list), and `APP_VERSION` in `app.js`.
2. Copy the folder to the host (re-drag to Netlify Drop, or push for GitHub Pages).
3. On the phone, open the app once online; the next open uses the new version.

## How the data flows (short version)

- On open: render from the cached bootstrap in `localStorage` at once, then refresh from the Sheet in
  the background. No cache yet → `program.json`.
- Typing in a workout updates a per-day draft in `localStorage` immediately (a phone lock loses
  nothing). The draft is discarded the next day.
- **Save workout** queues one `logSets` POST with every set that is ticked done or was edited, and
  only the ones that changed since the last save. A changed value after a save is a new row (the Log
  tab is append-only; latest row per set wins). The session row (completed flag, the Notes box, the
  duration) is queued whenever it changed; the script updates the row in place by `client_id`.
  **Save & finish** marks it completed and returns Home, where "Next up" has moved on.
- The queue is retried after every save, when the phone comes back online, when the app is reopened,
  and from the Retry button on Home or Settings. `client_id`s make retries safe.
- Week lives on Home (stepper). After Day 4 of the current week is finished, Home offers "Start Week
  N+1" with one tap; after Day 3, the same offer appears when Day 1 is opened next.

## Changing the program

Edit the `Program` tab in the Sheet; the app reflects it on the next open. `program.json` only
supplies the phase banners, week notes and cool-down lines (and the offline fallback), so regenerate
and re-copy it (`python reference/gen_package.py`, then copy `data/program.json` here) only when
those change.
