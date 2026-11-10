# web/ — the app

Vanilla HTML/CSS/JS, no build step. Deploy by copying this folder to any static host.

```
web/
  index.html             the one page; three views (Home / Workout / History) plus Session, Exercise, Settings
  app.js                 everything: apiGet/apiPost helpers (docs/SPEC.md §4.3), state, offline queue, views
  styles.css             mobile-first, 44px tap targets, safe-area padding, dark mode via prefers-color-scheme
  config.js              API_URL + TOKEN — copy from config.example.js. Committed in this deploy repo on purpose (GitHub Pages needs it; see docs/SPEC.md §8 in the project folder)
  config.example.js      template for config.js
  program.json           copy of ../data/program.json: phase banners, week notes, and the offline /
                         first-paint copy of the program (the Sheet's Program tab wins once loaded; a day
                         the Sheet lacks, like the Walk day, falls back to this copy)
  videos.js              the "▶ how to" lookup: exercise name → YouTube search phrase (or a specific video
                         URL, or '' for no link). Unlisted exercises search "<name> proper form"
  starting.js            the day-one weight hints: exercise name → "15–20" / "5" / "pin", shown faint in the
                         weight box until the exercise has a logged weight (from docs/PROGRAM.md's table)
  manifest.webmanifest   PWA manifest (docs/SPEC.md §7)
  sw.js                  tiny service worker: saved copy first (opens at once), refreshed in the background
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

1. Bump the version so Safari and the service worker pick up the new files. From the project
   folder (one level up), `python tools/bump_version.py` raises it by one in all six places:
   `?v=` on `styles.css` and `app.js` in `index.html`, `VERSION` in `sw.js` (and the two `?v=` entries
   in its `SHELL` list), and `APP_VERSION` in `app.js`. `--check` only reports whether they agree.
   (`videos.js` and `starting.js` are in the `SHELL` list too; bumping `VERSION` refreshes them.)
2. Copy the folder to the host (re-drag to Netlify Drop, or push for GitHub Pages).
3. On the phone, open the app once online. It opens from its saved copy (the old version), fetches
   the new one in the background and reloads itself once to show it — a second or two later, and
   only when she is not inside a workout (then the next open has it). Settings shows "app v…".
   The local preview on `localhost` skips the service worker's cache, so an edit shows on reload.

## How the data flows (short version)

- On open: render from the cached bootstrap in `localStorage` at once, then refresh from the Sheet in
  the background. No cache yet → `program.json`.
- Typing or ticking in a workout updates a per-day draft in `localStorage` immediately (a phone lock
  loses nothing). Three seconds after the last change, the **background save** queues one `logSets`
  POST with every set that is ticked done or was edited, and only the ones that changed since the
  last send; leaving the page or hiding the app sends at once. There is no Save button. A changed
  value after a send is a new row (the Log tab is append-only; latest row per set wins). The session
  row (completed flag, the Notes box, the timer, the duration) is queued whenever it changed; the
  script updates the row in place by `client_id`. **Finish workout** marks it completed and returns
  Home, which shows a summary card (minutes, sets, weights that went up) and the new "Next up".
- A draft from another day that was never finished is not thrown away: Home asks "You logged 9 sets
  on Day 1 but didn't finish it" with *Finish it* / *Discard*. Today's unfinished draft shows on Home
  as "Continue where you left off · 6 of 14 sets done".
- The queue is retried after every save, when the phone comes back online, when the app is reopened,
  and from the Retry button on Home or Settings. `client_id`s make retries safe.
- **swap** (under an exercise name) replaces that Program slot for today with another exercise from
  the Sheet's `Exercises` tab, same body part, same category first. The swap lives in the day's draft;
  logged sets name the exercise done plus `swapped_from`. **☆ favorite** queues a `favorite` POST
  (the `Favorites` tab) and marks the exercise ★ in the picker. Both links appear only when the
  bootstrap carries an `exercises` list, i.e. once the Sheet has the tab and the script is current.
- Week lives on Home (stepper). After Day 4 of the current week is finished, Home offers "Start Week
  N+1" with one tap; after Day 3, the same offer appears when Day 1 is opened next.
- **Cardio lines** (the warm-up, the finisher, the Walk day): a machine dropdown (the Exercises tab's
  Cardio · Machine rows) and min / mi / kcal boxes. One Log row per line with the machine in
  `exercise`, the Program slot in `swapped_from` and the numbers in `minutes` / `distance_mi` /
  `calories`. **+ Add cardio** under the warm-up adds extra lines of the same shape (set 2, 3, … of
  the machine, `note` `extra cardio`; a removed line that was already sent gets a not-done correction
  row). **Walk with Blu** (the dashed card on Home) is a repeatable day with `day_id` `walk`:
  each Finish writes a session (minutes, miles) and the card is ready for the next walk.
- **The ⏱ clock**: timed sets, stretch holds and cardio lines open a full-screen clock; End writes
  the elapsed time into the row and ticks it. The start time is in the draft, so a locked phone
  comes back to the running clock.

## Changing the program

Edit the `Program` tab in the Sheet; the app reflects it on the next open. `program.json` only
supplies the phase banners and week notes (and the offline fallback), so regenerate
and re-copy it (`python reference/gen_package.py`, then copy `data/program.json` here) only when
those change.

A new exercise gets a "▶ how to" link automatically (a YouTube search for "<name> proper form"). To
tune the search phrase, or to pin a specific video once you have found a good one, add a line to
`videos.js` and redeploy. To give a new exercise a day-one weight hint in the weight box, add a line
to `starting.js` the same way; without one the box is simply empty until she logs a weight.
