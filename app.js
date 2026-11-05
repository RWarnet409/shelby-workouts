// app.js — Shelby's workout tracker. One ES module, no build step, no framework.
//
// Read it top to bottom:
//   1. Config and constants
//   2. localStorage helpers
//   3. API helpers — apiGet / apiPost are the ONLY places that talk to the Apps Script
//   4. Program helpers — phase for a week, the workout for a day, rep targets, the progression nudge
//   5. App state, bootstrap (program + last weights + sessions), offline queue
//   6. Drafts — the values typed into a workout, kept on this phone until they are saved
//   7. Views — Home, Workout, History, Session, Exercise, Settings (each returns an HTML string)
//   8. Events, routing, boot

import { API_URL, TOKEN } from './config.js';
import { VIDEOS } from './videos.js';          // exercise → YouTube search phrase (the ▶ how-to links)
import { START_WEIGHTS } from './starting.js'; // exercise → day-one weight hint, shown faint in the weight box

// ------------------------------------------------------------------------------- 1. config
const APP_VERSION = '14';                      // keep in step with ?v= in index.html and VERSION in sw.js
const DAY_ORDER = ['day1', 'day2', 'day3', 'day4'];
const WALK_ID = 'walk';                        // "Walk with Blu": a repeatable day outside the 1 → 4 cycle
const ALL_DAY_IDS = DAY_ORDER.concat(WALK_ID);
// The cardio dropdown until the Sheet's Exercises tab has arrived (its Cardio · Machine rows win)
const CARDIO_FALLBACK = ['Treadmill', 'Elliptical', 'Recumbent Bike', 'Spin Bike', 'StairMaster', 'Air Bike', 'Arm Bike', 'Outdoor Walk'];
const REQUEST_TIMEOUT_MS = 20000;              // Apps Script usually answers in 1–3 s
const STALE_AFTER_MS = 10 * 60 * 1000;         // re-fetch bootstrap when the app is reopened after this long
const AUTOSAVE_MS = 3000;                      // a change in the workout is sent to the sheet this long after the last tap
const LS = {
  bootstrap: 'swa.bootstrap',                  // { program, last, sessions, fetchedAt } — last good API answer
  programJson: 'swa.programJson',              // copy of program.json (phase banners, week notes, cool-downs)
  week: 'swa.week',                            // the week shown on Home, once it has been set by hand
  queue: 'swa.queue',                          // unsent POSTs: [{ id, action, sets | session, createdAt }]
  dismissedSuggest: 'swa.dismissedSuggest',    // client_id of the session whose "next week?" banner was dismissed
  draftPrefix: 'swa.draft.',                   // + day_id → the workout in progress for that day
  stale: 'swa.stale',                          // drafts from another day that were started but never finished
  summary: 'swa.summary',                      // what the last Finish did (sets, minutes, weights that went up) until dismissed
  cardioLast: 'swa.cardioLast',                // Program slot → the cardio machine she picked last time
};

// ------------------------------------------------------------------------------- 2. storage
function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch (e) {
    console.warn('localStorage read failed', key, e);
    return fallback;
  }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (e) { console.warn('localStorage write failed', key, e); }
}
function lsRemove(key) {
  try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------------------------- 3. API
function apiConfigured() {
  return typeof API_URL === 'string' && API_URL.startsWith('https://') && !API_URL.includes('DEPLOYMENT_ID');
}

async function fetchWithTimeout(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

async function readJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error('non-JSON response (HTTP ' + response.status + ')'); }
}

// GET: token and params in the query string; follow the 302 that Apps Script answers with.
export async function apiGet(params = {}) {
  const u = new URL(API_URL);
  Object.entries({ ...params, token: TOKEN }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetchWithTimeout(u, { redirect: 'follow' });
  return readJson(r);
}

// POST: JSON in a text/plain body, so the browser skips the CORS preflight Apps Script cannot answer.
export async function apiPost(body) {
  const r = await fetchWithTimeout(API_URL, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...body, token: TOKEN }),
  });
  return readJson(r);
}

// ------------------------------------------------------------------------------- 4. program helpers
function phaseForWeek(week) {
  return week <= 2 ? 1 : week <= 4 ? 2 : 3;      // weeks 7+ keep using Phase 3
}

function phaseInfo(phase) {
  const phases = (state.programJson && state.programJson.phases) || [];
  return phases.find(p => p.phase === phase) || null;
}

function weekNote(week) {
  const notes = (state.programJson && state.programJson.week_notes) || {};
  if (notes[String(week)]) return notes[String(week)];
  if (week >= 7) {
    return 'Week ' + week + ': the 6 weeks are done. Take one light week (Week 1 sets and weights), ' +
      'then set the week back to 3 and restart with your Week 6 weights.';
  }
  return '';
}

// program.json → the same flat rows the Sheet's Program tab gives us. Used until the API has answered.
function flattenProgramJson(pj) {
  const rows = [];
  const days = {};
  (pj.days || []).forEach(d => { days[d.day_id] = d; });
  (pj.workouts || []).forEach(w => {
    const day = days[w.day_id] || {};
    const ph = (pj.phases || []).find(p => p.phase === w.phase) || {};
    const weeks = ph.weeks || [];
    (w.blocks || []).forEach(b => (b.exercises || []).forEach(e => rows.push({
      phase: w.phase, phase_name: ph.name || '',
      week_start: weeks[0] || null, week_end: weeks[weeks.length - 1] || null,
      day_id: w.day_id, day_label: day.day_label || '', weekday: day.weekday || '',
      focus: day.focus || '', minutes: day.minutes || null,
      block_order: b.block_order, block: b.block, block_type: b.block_type, sets: b.sets,
      exercise_order: e.exercise_order, exercise: e.exercise, target: e.target,
      log_weight: !!e.log_weight, unit: e.unit || 'reps', note: e.note || '',
    })));
  });
  return rows;
}

function dayMeta(dayId) {
  const fromJson = ((state.programJson && state.programJson.days) || []).find(d => d.day_id === dayId) || {};
  const row = state.program.find(r => r.day_id === dayId) || {};      // the Sheet wins when it has a value
  return {
    day_id: dayId,
    day_label: row.day_label || fromJson.day_label || dayId,
    weekday: row.weekday || fromJson.weekday || '',
    focus: row.focus || fromJson.focus || '',
    minutes: row.minutes || fromJson.minutes || null,
  };
}

// The blocks and exercises for one day in one phase, in display order.
function workoutFor(phase, dayId) {
  let rows = state.program.filter(r => Number(r.phase) === phase && r.day_id === dayId);
  if (!rows.length && state.programJson) {     // a day the Sheet doesn't have yet (the Walk day): program.json's copy
    rows = flattenProgramJson(state.programJson).filter(r => Number(r.phase) === phase && r.day_id === dayId);
  }
  const blocks = new Map();
  rows.forEach(r => {
    const key = Number(r.block_order);
    if (!blocks.has(key)) {
      blocks.set(key, {
        block_order: key, block: r.block, block_type: r.block_type,
        sets: r.sets === null || r.sets === undefined || r.sets === '' ? null : Number(r.sets),
        exercises: [],
      });
    }
    blocks.get(key).exercises.push(r);
  });
  const list = [...blocks.values()].sort((a, b) => a.block_order - b.block_order);
  list.forEach(b => b.exercises.sort((a, c) => Number(a.exercise_order) - Number(c.exercise_order)));
  const wj = ((state.programJson && state.programJson.workouts) || [])
    .find(w => w.phase === phase && w.day_id === dayId);
  return { phase, dayId, blocks: list, cooldown: (wj && wj.cooldown) || '' };
}

// "10–12" → {min 10, max 12}; "30–45 sec" → {30, 45}; "10/leg" → {10, 10}; "" → {null, null}
function parseTarget(target) {
  const t = String(target || '');
  const range = t.match(/(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const single = t.match(/(\d+(?:\.\d+)?)/);
  if (single) return { min: Number(single[1]), max: Number(single[1]) };
  return { min: null, max: null };
}

function isMachine(name) { return /machine|cable|pulldown/i.test(name); }

// "▶ how to" link for an exercise: videos.js entry if there is one, else a YouTube search for the
// name. Returns '' when the entry is '' (cardio lines get no link).
const VIDEO_LOOKUP = new Map(Object.entries(VIDEOS).map(([k, v]) => [videoKey(k), v]));
function videoKey(name) { return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function videoHref(name) {
  const key = videoKey(name);
  if (!key) return '';
  const lib = libraryRow(name);                       // a `video` cell in the Exercises tab wins
  const entry = lib && lib.video ? lib.video
    : VIDEO_LOOKUP.has(key) ? VIDEO_LOOKUP.get(key) : name + ' proper form';
  if (!entry) return '';
  if (/^https?:\/\//i.test(entry)) return entry;
  return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(entry);
}
function videoLink(name) {
  const href = videoHref(name);
  if (!href) return '';
  return '<a class="ex-video" href="' + esc(href) + '" target="_blank" rel="noopener"' +
    ' aria-label="How to do ' + esc(name) + ' (opens YouTube)">▶ how to</a>';
}

// Day-one hint for the weight box ("15–20", "5", "pin"), from starting.js. Shown as the placeholder
// until the exercise has a logged weight.
const START_LOOKUP = new Map(Object.entries(START_WEIGHTS).map(([k, v]) => [videoKey(k), v]));
function startWeightHint(name) { return START_LOOKUP.get(videoKey(name)) || ''; }

function unitLabel(unit) {
  return unit === 'time' ? 'sec' : unit === 'minutes' ? 'min' : 'reps';
}

// A warm-up / finisher / walk line that logs minutes (and miles, calories) instead of a bare tick:
// any line in a block without sets whose unit is minutes.
function isCardioRow(row, block) {
  return row.unit === 'minutes' && (block.sets === null || block.sets === undefined || Number(block.sets) <= 0);
}
// The dropdown on a cardio line: the library's Cardio · Machine rows, else the built-in list.
function cardioMachines() {
  const lib = state.exercises.filter(e => libKey(e.body_part) === 'cardio' && libKey(e.category) === 'machine').map(e => e.exercise);
  return lib.length ? lib : CARDIO_FALLBACK.slice();
}
// "5 min · 0.4 mi · 48 kcal" from anything carrying minutes / distance_mi / calories
function cardioSummary(x) {
  const has = v => v !== null && v !== undefined && v !== '';
  const parts = [];
  if (has(x.minutes)) parts.push(fmtNum(x.minutes) + ' min');
  if (has(x.distance_mi)) parts.push(fmtNum(x.distance_mi) + ' mi');
  if (has(x.calories)) parts.push(fmtNum(x.calories) + ' kcal');
  return parts.join(' · ');
}
function hasCardioNumbers(x) { return !!x && cardioSummary(x) !== ''; }

// ---- exercise library (the Exercises tab), swaps and favorites ------------------------
// The library is what makes "swap" and "☆ favorite" appear: without an Exercises tab in the Sheet
// (or with the old script, which doesn't send it) the workout page looks as it did before.
function libKey(name) { return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function hasLibrary() { return state.exercises.length > 0; }
function libraryRow(name) {
  const k = libKey(name);
  return state.exercises.find(e => libKey(e.exercise) === k) || null;
}
function isFavorite(name) {
  const k = libKey(name);
  return state.favorites.some(f => libKey(f) === k);
}

// A swapped-in exercise takes the slot's place in the block (same number of sets) and brings its own
// target, weight flag, unit and note from the library. `swapped_from` names the Program slot and is
// written to the Log with every set, so Ryan can see what was done instead of what.
function effectiveWorkout(workout, draft) {
  const swaps = (draft && draft.swaps) || {};
  return {
    ...workout,
    blocks: workout.blocks.map(b => ({
      ...b,
      exercises: b.exercises.map(row => {
        if ((b.sets === null || Number(b.sets) <= 0) && b.block_type !== 'stretch') return row;   // warm-up / cardio lines don't swap; stretches do
        const to = swaps[row.exercise];
        const lib = to ? libraryRow(to) : null;
        if (!lib || libKey(lib.exercise) === libKey(row.exercise)) return row;
        return {
          ...row, exercise: lib.exercise, target: lib.target || row.target, log_weight: !!lib.log_weight,
          unit: lib.unit || row.unit, note: lib.note || '', swapped_from: row.exercise,
        };
      }),
    })),
  };
}

// Alternatives for one Program slot: same body part and category first, then the rest of that body
// part; favorites first inside each group. Exercises already in today's workout are left out so two
// rows never share a name.
function swapOptions(slotName, workout) {
  const slot = libraryRow(slotName);
  if (!slot) return { slot: null, same: [], more: [] };
  const inUse = new Set();
  (workout ? workout.blocks : []).forEach(b => b.exercises.forEach(r => {
    inUse.add(libKey(r.exercise));
    if (r.swapped_from) inUse.add(libKey(r.swapped_from));
  }));
  const rank = (a, b) => (isFavorite(b.exercise) ? 1 : 0) - (isFavorite(a.exercise) ? 1 : 0) || a.exercise.localeCompare(b.exercise);
  const pool = state.exercises.filter(e => libKey(e.body_part) === libKey(slot.body_part) && !inUse.has(libKey(e.exercise)));
  return {
    slot,
    same: pool.filter(e => libKey(e.category) === libKey(slot.category)).sort(rank),
    more: pool.filter(e => libKey(e.category) !== libKey(slot.category)).sort(rank),
  };
}

// The last session of an exercise *before* `date`. While today's sets are being saved in the
// background, state.last already holds today's numbers; the previous session is kept in `prev`
// (applySetsToLast / applyBootstrap), so "last time", the nudge and the pre-fill keep pointing at
// the session before this one. No `prev` yet (fresh server answer mid-workout) → nothing to show.
function lastBefore(name, date) {
  const le = state.last[name];
  if (!le) return null;
  if (date && le.date === date) return le.prev || null;
  return le;
}

// Progression nudge (SPEC §5.2): last time every done set reached the top of the range → suggest more.
function nudgeFor(row, date) {
  if (!row.log_weight) return null;
  const le = lastBefore(row.exercise, date);
  if (!le || !Array.isArray(le.sets) || !le.sets.length) return null;
  const t = parseTarget(row.target);
  if (t.max === null || t.min === t.max) return null;          // no range to be at the top of
  const done = le.sets.filter(s => s.done);
  if (!done.length) return null;
  const allTop = done.every(s => Number(s.reps) >= t.max);
  if (!allTop) return null;
  if (/smith/i.test(row.exercise)) return 'All sets hit ' + t.max + '+ last time — add 5 lb a side';
  if (isMachine(row.exercise)) return 'All sets hit ' + t.max + '+ last time — go up one pin';
  if (le.weight === null || le.weight === undefined) return 'All sets hit ' + t.max + '+ last time — try a little more weight';
  return 'All sets hit ' + t.max + '+ last time — try ' + fmtNum(Number(le.weight) + 5) + ' lb';   // the rack goes up in 5s
}

// "15 lb × 12, 12, 11" or "15×12, 17.5×10" (weights differ) or "12, 12 reps" (bodyweight)
function setsSummary(sets, row) {
  if (sets.some(hasCardioNumbers)) return cardioSummary(sets.find(hasCardioNumbers));   // a cardio row: minutes · miles · kcal
  const unit = unitLabel(row ? row.unit : 'reps');
  const ws = sets.map(s => (s.weight === '' || s.weight === null || s.weight === undefined) ? null : Number(s.weight));
  const rs = sets.map(s => (s.reps === '' || s.reps === null || s.reps === undefined) ? '–' : String(s.reps));
  const allSame = ws.every(w => w === ws[0]);
  if (allSame) {
    if (ws[0] === null) return rs.join(', ') + ' ' + unit;
    return fmtNum(ws[0]) + ' lb × ' + rs.join(', ');
  }
  return sets.map((s, i) => (ws[i] === null ? 'BW' : fmtNum(ws[i])) + '×' + rs[i]).join(', ');
}

function lastTimeText(row, date) {
  const le = lastBefore(row.exercise, date);
  if (!le) return '';
  const sets = (le.sets || []).slice().sort((a, b) => a.set_number - b.set_number);
  if (sets.length) return setsSummary(sets, row);
  if (le.weight !== null && le.weight !== undefined) return fmtNum(le.weight) + ' lb';
  return '';
}

// Default values for a set before Shelby touches it: last time's numbers, else the target's low end.
// They show faint until she edits the field or ticks the set; ticking logs them as they are.
function prefill(row, setNo, date) {
  const le = lastBefore(row.exercise, date);
  const t = parseTarget(row.target);
  let weight = null;
  let reps = null;
  if (le) {
    const same = (le.sets || []).find(s => Number(s.set_number) === setNo);
    weight = same && same.weight !== null && same.weight !== undefined ? same.weight : le.weight;
    reps = same && same.reps !== null && same.reps !== undefined && same.reps !== '' ? same.reps : le.reps;
  }
  if (!row.log_weight) weight = null;
  if (reps === null || reps === undefined || reps === '') reps = t.min;
  return { weight: weight === undefined ? null : weight, reps: reps === undefined ? null : reps };
}

// ------------------------------------------------------------------------------- 5. state & data
const state = {
  programJson: null,        // contents of program.json
  program: [],              // flat Program rows (from the API, the cache, or program.json)
  programSource: 'none',    // 'api' | 'cache' | 'fallback'
  programUpdatedAt: null,   // ISO time of the last successful bootstrap
  last: {},                 // exercise → { date, weight, reps, sets: [{ set_number, weight, reps, done }] }
  sessions: [],             // most recent first
  exercises: [],            // the Exercises tab: swap library rows { exercise, body_part, category, target, ... }
  favorites: [],            // exercise names Shelby has starred (Favorites tab; latest row per exercise wins)
  week: 1,
  syncing: false,
  refreshing: false,
  queueCount: 0,
  route: { name: 'home' },
  prevHash: '',
};

let current = null;         // { draft, workout } while the Workout view is open

function applyBootstrap(b, source) {
  if (Array.isArray(b.program) && b.program.length) {
    state.program = b.program;
    state.programSource = source;
  }
  if (b.last && typeof b.last === 'object') state.last = mergeLast(b.last);
  if (Array.isArray(b.sessions)) state.sessions = b.sessions;
  if (Array.isArray(b.exercises)) state.exercises = b.exercises;   // absent from the old script → keep what we have
  if (Array.isArray(b.favorites)) state.favorites = b.favorites;
  if (b.fetchedAt) state.programUpdatedAt = b.fetchedAt;
}

// A fresh `last` from the sheet only knows the latest session per exercise. Keep the session before
// it (from what this phone already had) as `prev`, so a refresh mid-workout doesn't turn "last time"
// into today's half-finished numbers.
function mergeLast(fresh) {
  Object.keys(fresh).forEach(k => {
    const now = fresh[k];
    const old = state.last[k];
    if (!old || !now || !now.date || !old.date) return;
    if (old.date < now.date) {
      now.prev = { date: old.date, weight: old.weight, reps: old.reps, sets: old.sets || [],
        minutes: old.minutes, distance_mi: old.distance_mi, calories: old.calories };
    }
    else if (old.date === now.date && old.prev) now.prev = old.prev;
  });
  return fresh;
}

function persistBootstrapCache() {
  lsSet(LS.bootstrap, {
    program: state.programSource === 'fallback' ? [] : state.program,
    last: state.last,
    sessions: state.sessions,
    exercises: state.exercises,
    favorites: state.favorites,
    fetchedAt: state.programUpdatedAt,
  });
}

async function loadProgramJson() {
  const cached = lsGet(LS.programJson, null);
  if (cached) state.programJson = cached;
  const fetchIt = fetch('./program.json')
    .then(r => (r.ok ? r.json() : null))
    .then(pj => { if (pj) { state.programJson = pj; lsSet(LS.programJson, pj); } })
    .catch(e => console.warn('program.json not reachable', e));
  if (!cached) await fetchIt;                 // first ever load: wait for it; later loads use the copy
}

function isStale() {
  if (!state.programUpdatedAt) return true;
  return Date.now() - new Date(state.programUpdatedAt).getTime() > STALE_AFTER_MS;
}

async function refreshBootstrap() {
  if (!apiConfigured() || state.refreshing) return false;
  state.refreshing = true;
  try {
    const res = await apiGet({ action: 'bootstrap' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'bad response');
    res.fetchedAt = new Date().toISOString();
    applyBootstrap(res, 'api');
    replayQueueIntoState();                   // keep unsynced saves visible until they land
    persistBootstrapCache();
    return true;
  } catch (e) {
    console.warn('bootstrap refresh failed', e);
    return false;
  } finally {
    state.refreshing = false;
  }
}

// ---- offline queue ----------------------------------------------------------------
function readQueue() { return lsGet(LS.queue, []); }
function writeQueue(q) { lsSet(LS.queue, q); state.queueCount = q.length; }
function enqueue(item) {
  const q = readQueue();
  q.push({ id: uuid(), createdAt: new Date().toISOString(), ...item });
  writeQueue(q);
}
// A session row supersedes any copy of itself still waiting in the queue (same client_id).
function enqueueSession(session) {
  const q = readQueue().filter(i => !(i.action === 'session' && i.session.client_id === session.client_id));
  q.push({ id: uuid(), createdAt: new Date().toISOString(), action: 'session', session });
  writeQueue(q);
}
function queuedItems(action) { return readQueue().filter(i => i.action === action); }
function queuedSessionIds() { return new Set(queuedItems('session').map(i => i.session.client_id)); }
function queuedSetRows(match) {
  const out = [];
  queuedItems('logSets').forEach(i => (i.sets || []).forEach(s => { if (match(s)) out.push(s); }));
  return out;
}

// Mirror of lastPerExercise_() in Code.gs, applied to sets saved on this phone.
function applySetsToLast(sets) {
  sets.forEach(s => {
    const e = state.last[s.exercise] || (state.last[s.exercise] = { date: null, weight: null, reps: null, sets: [] });
    if (e.date !== s.date) {                                   // a new session: remember the one before it
      if (e.date) {
        e.prev = { date: e.date, weight: e.weight, reps: e.reps, sets: e.sets || [],
          minutes: e.minutes, distance_mi: e.distance_mi, calories: e.calories };
      }
      e.date = s.date; e.sets = [];
    }
    if (s.weight !== null && s.weight !== undefined) e.weight = s.weight;
    if (s.reps !== null && s.reps !== undefined && s.reps !== '') e.reps = s.reps;
    ['minutes', 'distance_mi', 'calories'].forEach(k => { if (s[k] !== null && s[k] !== undefined && s[k] !== '') e[k] = s[k]; });
    const nn = v => (v === undefined ? null : v);
    const rec = { set_number: s.set_number, weight: s.weight, reps: s.reps, done: !!s.done,
      minutes: nn(s.minutes), distance_mi: nn(s.distance_mi), calories: nn(s.calories) };
    const i = e.sets.findIndex(x => Number(x.set_number) === s.set_number);
    if (i >= 0) e.sets[i] = rec; else e.sets.push(rec);
    e.sets.sort((a, b) => a.set_number - b.set_number);
  });
}

function replayQueueIntoState() {
  queuedItems('logSets').forEach(i => applySetsToLast(i.sets || []));
  queuedItems('session').forEach(i => {                      // a queued copy is newer than the server's
    const rec = { ...i.session, timestamp: i.createdAt };
    const idx = state.sessions.findIndex(s => s.client_id === i.session.client_id);
    if (idx >= 0) state.sessions[idx] = rec; else state.sessions.unshift(rec);
  });
  queuedItems('favorite').forEach(i => {
    const k = libKey(i.favorite.exercise);
    state.favorites = state.favorites.filter(f => libKey(f) !== k);
    if (i.favorite.favorite) state.favorites.push(i.favorite.exercise);
  });
}

// Star / unstar an exercise: updates this phone at once and queues one row for the Favorites tab.
// A newer toggle for the same exercise replaces an older one still waiting in the queue.
function toggleFavorite(name) {
  const on = !isFavorite(name);
  const k = libKey(name);
  state.favorites = state.favorites.filter(f => libKey(f) !== k);
  if (on) state.favorites.push(name);
  const q = readQueue().filter(i => !(i.action === 'favorite' && libKey(i.favorite.exercise) === k));
  q.push({ id: uuid(), createdAt: new Date().toISOString(), action: 'favorite',
    favorite: { client_id: uuid(), exercise: name, favorite: on } });
  writeQueue(q);
  persistBootstrapCache();
  return on;
}

// Send everything in the queue, oldest first. Items that fail stay queued for the next try.
async function flushQueue() {
  if (state.syncing || !apiConfigured()) return;
  state.syncing = true;
  const processed = new Set();
  const failed = [];
  try {
    let pass = readQueue();
    while (pass.length) {
      let networkDown = false;
      for (const item of pass) {
        processed.add(item.id);
        if (networkDown) { failed.push(item); continue; }
        try {
          const body = item.action === 'session' ? { action: 'session', session: item.session }
            : item.action === 'favorite' ? { action: 'favorite', favorite: item.favorite }
            : { action: 'logSets', sets: item.sets };
          const res = await apiPost(body);
          if (res && res.ok) continue;
          item.lastError = (res && res.error) || 'rejected';
          item.attempts = (item.attempts || 0) + 1;
          failed.push(item);
        } catch (e) {
          item.lastError = 'network';
          networkDown = true;
          failed.push(item);
        }
      }
      const added = readQueue().filter(i => !processed.has(i.id));   // saved while we were sending
      writeQueue(failed.concat(added));
      pass = networkDown ? [] : added;
    }
  } finally {
    state.syncing = false;
  }
}

// ---- week & next-up ---------------------------------------------------------------
function isTrue(v) { return v === true || String(v).toLowerCase() === 'true'; }

function lastCompletedSession() {
  return state.sessions.find(s => isTrue(s.completed) && s.day_id !== WALK_ID) || null;   // walks don't move next-up
}

// Completed walks with Blu in the current week, newest first.
function walksThisWeek() {
  return state.sessions.filter(x => x.day_id === WALK_ID && Number(x.week) === state.week && isTrue(x.completed));
}

// The day after the last completed session in the cycle 1 → 2 → 3 → 4 → 1. Days already done this
// week (out of order) are skipped over, so next-up is always one still to do; once all four are
// done it is the cycle's next day, i.e. where next week starts.
function nextUpDayId() {
  const s = lastCompletedSession();
  let next = 'day1';
  if (s) {
    const i = DAY_ORDER.indexOf(s.day_id);
    next = i < 0 ? 'day1' : DAY_ORDER[(i + 1) % DAY_ORDER.length];
  }
  const start = DAY_ORDER.indexOf(next);
  for (let k = 0; k < DAY_ORDER.length; k++) {
    const d = DAY_ORDER[(start + k) % DAY_ORDER.length];
    if (!doneThisWeek(d)) return d;
  }
  return next;
}

// The completed session for that day in the current week, or null.
function doneThisWeek(dayId) {
  return state.sessions.find(x => x.day_id === dayId && Number(x.week) === state.week && isTrue(x.completed)) || null;
}

function initWeek() {
  const stored = lsGet(LS.week, null);
  if (Number.isInteger(stored) && stored >= 1) { state.week = stored; return; }
  const s = lastCompletedSession();
  state.week = s && Number(s.week) >= 1 ? Number(s.week) : 1;
}

function setWeek(week) {
  state.week = Math.max(1, Math.round(week));
  lsSet(LS.week, state.week);
}

// After Day 4 (or Day 3 when Day 1 is picked next) completes in the current week, offer the next week.
function weekSuggestion(where, dayId) {
  const s = lastCompletedSession();
  if (!s || Number(s.week) !== state.week) return null;
  if (lsGet(LS.dismissedSuggest, null) === s.client_id) return null;
  const next = state.week + 1;
  const onDay1 = where === 'workout' && dayId === 'day1';
  if (s.day_id === 'day4' && (where === 'home' || onDay1)) {
    return { next, sessionId: s.client_id, text: 'Week ' + state.week + ' done — nice. Ready for Week ' + next + '?' };
  }
  if (s.day_id === 'day3' && onDay1) {
    return { next, sessionId: s.client_id, text: 'Back to Day 1? If Day 4 is skipped this week, this is Week ' + next + '.' };
  }
  return null;
}

// ------------------------------------------------------------------------------- 6. drafts
function draftKey(dayId) { return LS.draftPrefix + dayId; }
function setKey(exercise, n) { return exercise + '|' + n; }

function loadDraft(dayId, phase) {
  const today = todayIso();
  const d = lsGet(draftKey(dayId), null);
  const loggedWalk = dayId === WALK_ID && d && d.completed;    // a walk already logged: the next open starts a new one
  if (d && d.date === today && !loggedWalk) {
    d.phase = phase;                          // the week was changed mid-day: keep what she has typed
    if (!d.swaps) d.swaps = {};               // drafts from before swaps existed
    if (!d.collapsed) d.collapsed = {};       // drafts from before collapsing existed
    if (!d.cardio) d.cardio = {};             // drafts from before cardio lines and the ⏱ existed
    if (!d.checkSecs) d.checkSecs = {};
    if (d.setTimer === undefined) d.setTimer = null;
    if (d.timerStartedAt === undefined) {     // drafts from before the timer existed
      d.timerStartedAt = null; d.timerPausedAt = null; d.timerPausedMs = 0; d.timerStoppedAt = null;
    }
    if (d.timerEnded === undefined) d.timerEnded = false;
    return d;
  }
  if (d) shelveDraft(d);                      // another day's workout: keep it until she decides (Home asks)
  return {
    dayId, date: today, phase, week: state.week,
    createdAt: new Date().toISOString(),
    startedAt: null,                          // first tap/typing; fallback for duration_min when the timer wasn't used
    lastActivityAt: null,                     // last tap/typing; where an abandoned workout's time stops
    timerStartedAt: null,                     // the workout timer (local ISO with offset); survives closing the app
    timerPausedAt: null,                      // set while paused (End is a pause that looks final)
    timerPausedMs: 0,                         // total time spent paused, not counted in the elapsed time
    timerEnded: false,                        // she tapped End: show the time as final, offer Start again
    timerStoppedAt: null,                     // set by Finish — the only thing that really ends it
    sets: {},                                 // "exercise|n" → { weight, reps, done, touched, sentSig, prevWeight }
    checks: {},                               // warmup / stretch lines → true when ticked (cardio lines mirror their ✓ here)
    checksSent: {},                           // exercise → the "done|seconds" signature last queued
    checkSecs: {},                            // check lines timed with the ⏱: exercise → seconds
    cardio: {},                               // cardio lines: Program slot → { machine, minutes, distance, calories, done, touched, sentSig };
                                              //   extra lines ("+ Add cardio") sit here too, keyed "<slot>#2", "<slot>#3", … with baseSlot / setNumber
    setTimer: null,                           // the ⏱ clock while it runs: { kind, key | name | slot, label, sub, target, startedAt }
    swaps: {},                                // Program exercise → the library exercise done instead, today only
    collapsed: {},                            // exercise → true when she folded its set rows away
    note: '',                                 // the Notes box at the bottom of the page
    completed: false,                         // true once Finish has been tapped
    durationMin: null,                        // minutes from the first tap to Finish
    sessionClientId: uuid(),
    sentSessionSig: null,                     // "completed|note" as last queued; a change re-sends the row
  };
}
function saveDraft(d) { lsSet(draftKey(d.dayId), d); }

// Anything typed or ticked? (decides whether an old draft is worth asking about)
function draftHasActivity(d) {
  if (!d) return false;
  return Object.values(d.sets || {}).some(s => s.done || s.touched) ||
    Object.values(d.checks || {}).some(Boolean) ||
    Object.values(d.cardio || {}).some(c => c.done || c.touched) ||
    String(d.note || '').trim() !== '' || !!d.timerStartedAt;
}

// Sets ticked done out of the sets in the workout (set rows only; the warm-up and finisher lines
// don't count, so an optional finisher never blocks "that's everything").
function setProgress(draft, workout) {
  let done = 0;
  let total = 0;
  workout.blocks.forEach(b => {
    const n = b.sets === null ? 0 : Number(b.sets);
    if (n <= 0) return;
    b.exercises.forEach(row => {
      for (let i = 1; i <= n; i++) {
        total++;
        const s = draft.sets[setKey(row.exercise, i)];
        if (s && s.done) done++;
      }
    });
  });
  return { done, total };
}
function exerciseProgress(draft, row, n) {
  let done = 0;
  for (let i = 1; i <= n; i++) { const s = draft.sets[setKey(row.exercise, i)]; if (s && s.done) done++; }
  return { done, total: n };
}

// ---- abandoned drafts ---------------------------------------------------------------
// A workout from another day that was started but never finished is moved aside (not thrown away)
// the next time that day is opened. Home then asks: finish it (the sets land in the sheet and the
// session counts) or discard it.
function staleDrafts() { return lsGet(LS.stale, []); }
function shelveDraft(d) {
  if (d.completed || !draftHasActivity(d)) return;
  const list = staleDrafts().filter(x => x.sessionClientId !== d.sessionClientId);
  list.push(d);
  lsSet(LS.stale, list);
}
function dropStaleDraft(sessionId) {
  lsSet(LS.stale, staleDrafts().filter(x => x.sessionClientId !== sessionId));
}
// Every day's draft is checked, not just the day being opened, so Home can ask right away.
function shelveOldDrafts() {
  const today = todayIso();
  ALL_DAY_IDS.forEach(dayId => {
    const d = lsGet(draftKey(dayId), null);
    if (d && d.date !== today) { shelveDraft(d); lsRemove(draftKey(dayId)); }
  });
}
// The draft for today that has something in it and isn't finished — what the Continue card shows.
function inProgressDraft() {
  const today = todayIso();
  for (const dayId of ALL_DAY_IDS) {
    const d = lsGet(draftKey(dayId), null);
    if (d && d.date === today && !d.completed && draftHasActivity(d)) return d;
  }
  return null;
}

let draftSaveTimer = null;
function scheduleDraftSave() {
  if (current) current.draft.lastActivityAt = new Date().toISOString();
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => { if (current) saveDraft(current.draft); }, 250);
  scheduleAutosave();
}

function getSetEntry(draft, row, n) {
  const k = setKey(row.exercise, n);
  if (!draft.sets[k]) {
    const p = prefill(row, n, draft.date);
    draft.sets[k] = { exercise: row.exercise, set_number: n, weight: p.weight, reps: p.reps, done: false, touched: false, sentSig: null,
      prevWeight: p.weight };                 // last time's weight, kept for the "went up" line on Finish
  }
  return draft.sets[k];
}

// The cardio line's entry: the machine (her last pick for this slot, else the first in the list) with
// last time's minutes / miles / kcal for that machine pre-filled faint, like a set row.
function defaultMachine(slot) {
  const remembered = lsGet(LS.cardioLast, {})[slot];
  const machines = cardioMachines();
  if (remembered && machines.includes(remembered)) return remembered;
  return (/spin/i.test(slot) && machines.find(m => /spin/i.test(m))) || machines[0];
}
function getCardioEntry(draft, row, withMachine) {
  const slot = row.exercise;
  if (!draft.cardio) draft.cardio = {};
  let c = draft.cardio[slot];
  if (!c) {
    c = draft.cardio[slot] = { slot, machine: withMachine ? defaultMachine(slot) : row.exercise,
      minutes: null, distance: null, calories: null, done: !!draft.checks[slot], touched: false, sentSig: null };
    applyCardioPrefill(c, draft.date);
  }
  return c;
}
// Last time's numbers for this line: the same set_number on that machine (1 = the Program line,
// 2+ = an extra cardio line), so a 20-minute extra on the treadmill doesn't become the warm-up's
// pre-fill. Set 1 falls back to the machine's latest numbers (rows from before set records had them).
function cardioLastFor(c, date) {
  const le = lastBefore(c.machine, date);
  if (!le) return null;
  const n = c.setNumber || 1;
  const rec = (le.sets || []).find(x => Number(x.set_number) === n);
  if (rec && hasCardioNumbers(rec)) return rec;
  return n === 1 ? le : null;
}
function applyCardioPrefill(c, date) {
  const le = cardioLastFor(c, date);
  const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
  c.minutes = le ? num(le.minutes) : null;
  c.distance = le ? num(le.distance_mi) : null;
  c.calories = le ? num(le.calories) : null;
}
// The extra cardio lines under a Program cardio slot (the warm-up's "+ Add cardio"), in order.
// `includeRemoved` adds the ones she took off again (they may still owe the Log a correction row).
function extraCardio(draft, slot, includeRemoved) {
  return Object.values(draft.cardio || {})
    .filter(c => c.baseSlot === slot && (includeRemoved || !c.removed))
    .sort((a, b) => (a.setNumber || 0) - (b.setNumber || 0));
}
// "+ Add cardio": one more line under the slot, logged as set 2, 3, … of the machine she picks.
// A line removed earlier keeps its key and what was last sent, so adding again reuses it.
function addExtraCardio(draft, slot) {
  if (!draft.cardio) draft.cardio = {};
  let n = 2;
  while (draft.cardio[slot + '#' + n] && !draft.cardio[slot + '#' + n].removed) n++;
  const key = slot + '#' + n;
  const old = draft.cardio[key];
  const c = draft.cardio[key] = { slot: key, baseSlot: slot, setNumber: n, machine: defaultMachine(key),
    minutes: null, distance: null, calories: null, done: false, touched: false, sentSig: old ? old.sentSig : null, removed: false };
  applyCardioPrefill(c, draft.date);
  return c;
}
// Remove an extra line. Never sent → it just goes. Already in the Log → it stays in the draft as a
// correction (not done, no numbers) for the next save, so the latest row per set wins as always.
// Returns true when a correction needs sending.
function removeExtraCardio(draft, key) {
  const c = draft.cardio && draft.cardio[key];
  if (!c) return false;
  delete draft.checks[key];
  if (!c.sentSig) { delete draft.cardio[key]; return false; }
  c.removed = true; c.done = false; c.touched = false; c.minutes = null; c.distance = null; c.calories = null;
  return true;
}
// The one cardio entry of a Walk draft (the "Walk with Blu" line), once it has been drawn.
function walkEntry(draft) {
  const list = Object.values(draft.cardio || {}).filter(c => !c.baseSlot && !c.removed);
  return list.length ? list[0] : null;
}

function markStarted(draft) {
  if (!draft.startedAt) draft.startedAt = new Date().toISOString();
}

// Rows to send: sets that are done or were edited, and only when they changed since the last save.
function collectSetsToSend(draft, workout, week) {
  const out = [];
  const base = { date: draft.date, week: week || state.week, phase: draft.phase, day_id: draft.dayId, note: '' };
  workout.blocks.forEach(b => {
    const n = b.sets === null ? 0 : Number(b.sets);
    b.exercises.forEach(row => {
      if (n > 0) {
        for (let i = 1; i <= n; i++) {
          const s = draft.sets[setKey(row.exercise, i)];
          if (!s || !(s.done || s.touched)) continue;
          const sig = [s.weight === null ? '' : s.weight, s.reps === null ? '' : s.reps, s.done ? 1 : 0].join('|');
          if (s.sentSig === sig) continue;
          s.sentSig = sig;
          out.push({ ...base, client_id: uuid(), exercise: row.exercise, swapped_from: row.swapped_from || '',
            set_number: i, weight: row.log_weight ? s.weight : null, reps: s.reps, done: !!s.done });
        }
      } else if (isCardioRow(row, b)) {                       // cardio line(s): the machine + minutes / miles / kcal
        const main = draft.cardio && draft.cardio[row.exercise];
        (main ? [main] : []).concat(extraCardio(draft, row.exercise, true)).forEach(c => {
          if (!(c.done || c.touched || c.removed)) return;
          const sig = [c.machine, c.minutes ?? '', c.distance ?? '', c.calories ?? '', c.done ? 1 : 0].join('|');
          if (c.sentSig === sig) return;
          c.sentSig = sig;
          const n = c.setNumber || 1;                              // 1 = the Program line, 2+ = "+ Add cardio"
          out.push({ ...base, client_id: uuid(), exercise: c.machine, swapped_from: c.machine === row.exercise ? '' : row.exercise,
            set_number: n, weight: null, reps: null, minutes: c.minutes, distance_mi: c.distance, calories: c.calories, done: !!c.done,
            note: n > 1 ? 'extra cardio' : '' });
        });
      } else if (draft.checks[row.exercise]) {                 // check line (warm-up move, stretch): once, and again when the ⏱ times it
        const secs = draft.checkSecs ? draft.checkSecs[row.exercise] : undefined;
        const sig = '1|' + (secs === null || secs === undefined ? '' : secs);
        const sent = draft.checksSent[row.exercise];
        if (sent === true ? sig === '1|' : sent === sig) return;   // `true` is how drafts before v13 marked it sent
        draft.checksSent[row.exercise] = sig;
        out.push({ ...base, client_id: uuid(), exercise: row.exercise, swapped_from: row.swapped_from || '',
          set_number: 1, weight: null, reps: secs === undefined ? null : secs, done: true });
      }
    });
  });
  return out;
}

// Minutes for Sessions.duration_min: the timer when it was used, else first tap → finish (5–180 min).
// `endMs` is when the workout ended: now, or the last tap for a workout finished after the fact.
function durationMinutes(draft, endMs) {
  if (draft.timerStartedAt && draft.timerStoppedAt) {
    return Math.max(1, Math.round(timerElapsedMs(draft) / 60000));
  }
  if (!draft.startedAt) return null;
  const end = endMs || Date.now();
  const mins = Math.round((end - new Date(draft.startedAt).getTime()) / 60000);
  return mins >= 5 && mins <= 180 ? mins : null;
}

// ---- workout timer -------------------------------------------------------------------
// A stopwatch: Start when she begins, Pause / Resume as needed, End when she thinks she is done.
// End is a pause that looks final and offers "Start again"; nothing is logged until Save & finish,
// which stamps timer_end (at the last End/Pause if it is paused, else now) and sets duration_min.
// Elapsed time leaves out the pauses.
function timerElapsedMs(draft) {
  if (!draft || !draft.timerStartedAt) return 0;
  const endIso = draft.timerStoppedAt || draft.timerPausedAt;
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  return Math.max(0, end - new Date(draft.timerStartedAt).getTime() - (draft.timerPausedMs || 0));
}
function timerRunning(draft) { return !!(draft && draft.timerStartedAt && !draft.timerStoppedAt && !draft.timerPausedAt); }
function timerPaused(draft) { return !!(draft && draft.timerStartedAt && !draft.timerStoppedAt && draft.timerPausedAt); }
function timerFinal(draft) { return !!(draft && draft.timerStartedAt && draft.timerStoppedAt); }

function timerPause(draft, now, ended) {
  if (timerRunning(draft)) draft.timerPausedAt = localIso(now);
  draft.timerEnded = !!ended;
}
// Resume / Start again: the pause (or the time since Save & finish) is folded into the paused total,
// so the clock carries on from where it was.
function timerUnpause(draft, now) {
  const since = draft.timerPausedAt || draft.timerStoppedAt;
  if (since) draft.timerPausedMs = (draft.timerPausedMs || 0) + Math.max(0, now.getTime() - new Date(since).getTime());
  draft.timerPausedAt = null;
  draft.timerStoppedAt = null;
  draft.timerEnded = false;
  draft.durationMin = null;
}
// Save & finish: the real end. A paused/ended timer ends at the moment it was paused.
function timerFinish(draft, now) {
  if (!draft.timerStartedAt || draft.timerStoppedAt) return;
  draft.timerStoppedAt = draft.timerPausedAt || localIso(now);
  draft.timerPausedAt = null;
  draft.timerEnded = false;
}

function fmtClock(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
}

// "2026-11-03T18:12:05.321-05:00": local time with the phone's offset, readable in the Sheet.
// Milliseconds are kept so the clock never appears to step back when it stops.
function localIso(d) {
  const p = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0') +
    sign + p(Math.floor(Math.abs(off) / 60)) + ':' + p(Math.abs(off) % 60);
}

function timerCard(draft) {
  const running = timerRunning(draft);
  const ended = timerPaused(draft) && !!draft.timerEnded;
  const paused = timerPaused(draft) && !ended;
  const final = timerFinal(draft);
  const cls = running ? ' running' : paused ? ' paused' : (ended || final) ? ' stopped' : '';
  const label = running ? 'Running' : paused ? 'Paused' : ended ? 'Ended' : final ? 'Workout time' : 'Workout timer';
  const endBtn = '<button type="button" class="btn small stop" data-action="timer-stop">■ End</button>';
  let actions;
  let hint = '';
  if (running) {
    actions = '<button type="button" class="btn small ghost" data-action="timer-pause">❚❚ Pause</button>' + endBtn;
  } else if (paused) {
    actions = '<button type="button" class="btn small primary" data-action="timer-resume">▶ Resume</button>' + endBtn;
  } else if (ended || final) {
    actions = '<button type="button" class="btn small ghost" data-action="timer-resume">▶ Start again</button>' +
      '<button type="button" class="ex-link" data-action="timer-reset">reset</button>';
    if (ended && !draft.completed) hint = '<p class="timer-hint">Finish workout logs the time.</p>';
  } else {
    actions = '<button type="button" class="btn small primary" data-action="timer-start">▶ Start</button>';
  }
  return '<div id="timer-card" class="card timer-card' + cls + '"><div class="timer-row">' +
    '<div><div class="timer-label">' + label + '</div>' +
    '<div class="timer-time" id="timer-time">' + fmtClock(timerElapsedMs(draft)) + '</div></div>' +
    '<div class="timer-actions">' + actions + '</div></div>' + hint + '</div>';
}

let timerTick = null;
function stopTick() { clearInterval(timerTick); timerTick = null; }
function startTick() {
  stopTick();
  timerTick = setInterval(() => {
    const el = document.getElementById('timer-time');
    if (!el || !current) { stopTick(); return; }
    el.textContent = fmtClock(timerElapsedMs(current.draft));
  }, 1000);
}
// Redraw just the timer card (keeps the rest of the page, inputs and scroll position as they are).
function refreshTimerCard() {
  if (!current) return;
  const old = document.getElementById('timer-card');
  if (old) old.outerHTML = timerCard(current.draft);
  if (timerRunning(current.draft)) startTick(); else stopTick();
}

// ---- the ⏱ clock ---------------------------------------------------------------------
// One full-screen clock for a timed set (plank), a stretch hold or a cardio line. Start opens it;
// End writes the elapsed time into the row (seconds, or minutes for cardio) and ticks it done; Cancel
// logs nothing. The start time lives in the draft, so a locked phone reopens on the running clock.
let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
}
function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ }
  wakeLock = null;
}
function openSetTimer(kind, btn) {
  if (!current) return;
  const { draft, workout } = current;
  const rows = workout.blocks.flatMap(b => b.exercises);
  let spec = null;
  if (kind === 'set') {
    const s = draft.sets[btn.dataset.key];
    const row = s && rows.find(r => r.exercise === s.exercise);
    if (!s || !row) return;
    spec = { kind, key: btn.dataset.key, label: row.exercise, sub: 'Set ' + s.set_number, target: row.target };
  } else if (kind === 'check') {
    const row = rows.find(r => r.exercise === btn.dataset.name);
    if (!row) return;
    spec = { kind, name: row.exercise, label: row.exercise, sub: '', target: row.target };
  } else if (kind === 'cardio') {
    const c = draft.cardio && draft.cardio[btn.dataset.slot];
    const row = c && rows.find(r => r.exercise === (c.baseSlot || c.slot));
    if (!c || !row) return;
    const extra = (c.setNumber || 1) > 1;                   // an extra line has no target to turn green at
    spec = { kind, slot: btn.dataset.slot, label: c.machine, sub: extra ? 'Extra cardio' : '', target: extra ? '' : row.target };
  }
  if (!spec) return;
  draft.setTimer = { ...spec, startedAt: localIso(new Date()) };
  markStarted(draft);
  saveDraft(draft);
  renderSetTimer();
}
function setTimerElapsedMs() {
  const t = current && current.draft.setTimer;
  return t ? Math.max(0, Date.now() - new Date(t.startedAt).getTime()) : 0;
}
// Seconds at which the clock turns green: the target's low end (minutes for a cardio line).
function setTimerGoalSecs(t) {
  const tg = parseTarget(t.target);
  if (tg.min === null) return null;
  return t.kind === 'cardio' ? tg.min * 60 : tg.min;
}
let setTick = null;
function stopSetTick() { clearInterval(setTick); setTick = null; }
function startSetTick() {
  stopSetTick();
  const tick = () => {
    const el = document.getElementById('tm-clock');
    const t = current && current.draft.setTimer;
    if (!el || !t) { stopSetTick(); return; }
    const ms = setTimerElapsedMs();
    el.textContent = fmtClock(ms);
    const goal = setTimerGoalSecs(t);
    el.classList.toggle('hit', goal !== null && ms / 1000 >= goal);
  };
  tick();
  setTick = setInterval(tick, 250);
}
function renderSetTimer() {
  const box = document.getElementById('timer-modal');
  if (!box) return;
  const t = current && current.draft.setTimer;
  if (!t) {
    if (!box.hidden) { box.hidden = true; box.innerHTML = ''; document.body.classList.remove('timer-open'); }
    stopSetTick();
    releaseWakeLock();
    return;
  }
  box.innerHTML = '<div class="tm" role="dialog" aria-modal="true" aria-label="Timer for ' + esc(t.label) + '">' +
    '<div class="tm-name">' + esc(t.label) + '</div>' +
    (t.sub ? '<div class="tm-sub">' + esc(t.sub) + '</div>' : '') +
    '<div class="tm-clock" id="tm-clock">' + fmtClock(setTimerElapsedMs()) + '</div>' +
    '<div class="tm-target">' + (t.target ? 'target ' + esc(t.target) : '') + '</div>' +
    '<button type="button" class="btn primary tm-end" data-action="set-timer-end">■ End</button>' +
    '<button type="button" class="btn ghost tm-cancel" data-action="set-timer-cancel">Cancel — don\'t log it</button></div>';
  box.hidden = false;
  document.body.classList.add('timer-open');
  startSetTick();
  requestWakeLock();
}
// End (log = true) or Cancel. The page is redrawn in place so the row shows the new number.
function closeSetTimer(log) {
  if (!current || !current.draft.setTimer) return;
  const draft = current.draft;
  const t = draft.setTimer;
  const ms = setTimerElapsedMs();
  draft.setTimer = null;
  if (log) {
    const secs = Math.max(1, Math.round(ms / 1000));
    if (t.kind === 'set') {
      const s = draft.sets[t.key];
      if (s) { s.reps = secs; s.touched = true; s.done = true; }
    } else if (t.kind === 'check') {
      if (!draft.checkSecs) draft.checkSecs = {};
      draft.checkSecs[t.name] = secs;
      draft.checks[t.name] = true;
    } else if (t.kind === 'cardio') {
      const c = draft.cardio && draft.cardio[t.slot];
      if (c) { c.minutes = Math.max(0.1, Math.round(ms / 6000) / 10); c.touched = true; c.done = true; draft.checks[t.slot] = true; }
    }
    markStarted(draft);
    draft.lastActivityAt = new Date().toISOString();
  }
  saveDraft(draft);
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
  if (log) scheduleAutosave();
}

// Queue the set rows and the session row, and update "last time" on this phone right away.
// Runs in the background a few seconds after every change, and once more on Finish (`finish`).
// The session row (completed flag, note, duration) goes out whenever it changed. The script updates
// the existing row for the same client_id, so a note added after finishing still lands.
// `opts.week` / `opts.endedAt` / `opts.persist` are for finishing an abandoned draft from Home.
function saveWorkout(draft, workout, finish, opts = {}) {
  const week = opts.week || state.week;
  const endedAt = opts.endedAt ? new Date(opts.endedAt) : new Date();
  if (finish) {
    if (opts.endedAt && timerRunning(draft)) draft.timerPausedAt = localIso(endedAt);   // abandoned with the clock running
    timerFinish(draft, endedAt);                           // Finish is what really ends the timer
  }
  const walk = draft.dayId === WALK_ID ? walkEntry(draft) : null;
  if (finish && walk && (walk.minutes === null || walk.minutes === undefined) && draft.timerStartedAt && draft.timerStoppedAt) {
    walk.minutes = Math.max(1, Math.round(timerElapsedMs(draft) / 60000));   // the workout timer clocked the walk
    walk.touched = true; walk.done = true; draft.checks[walk.slot] = true;
  }
  const sets = collectSetsToSend(draft, workout, week);
  if (sets.length) {
    enqueue({ action: 'logSets', sets });
    applySetsToLast(sets);
  }
  if (finish && !draft.completed) {
    draft.completed = true;
    lsRemove(LS.dismissedSuggest);
  }
  if (draft.completed || (draft.timerStartedAt && draft.timerStoppedAt)) draft.durationMin = durationMinutes(draft, endedAt.getTime());
  const typed = v => v !== null && v !== undefined && v !== '';
  if (walk && typed(walk.minutes)) draft.durationMin = Number(walk.minutes);          // a typed walk time wins
  const walkMiles = walk && typed(walk.distance) ? Number(walk.distance) : null;
  const note = String(draft.note || '').trim();
  const timerUsed = !!draft.timerStartedAt;
  const hasActivity = sets.length > 0 || note !== '' || draft.completed || timerUsed ||
    Object.values(draft.sets).some(s => s.sentSig) || Object.keys(draft.checksSent || {}).length > 0;
  const sessionSig = [draft.completed ? 1 : 0, note, draft.timerStartedAt || '', draft.timerStoppedAt || '', week,
    draft.durationMin || '', walkMiles === null ? '' : walkMiles].join('|');
  let sessionQueued = false;
  if (hasActivity && sessionSig !== (draft.sentSessionSig || null)) {
    const session = {
      client_id: draft.sessionClientId, date: draft.date, week, phase: draft.phase,
      day_id: draft.dayId, completed: !!draft.completed, duration_min: draft.durationMin || null, note,
      timer_start: draft.timerStartedAt || '', timer_end: draft.timerStoppedAt || '',
      distance_mi: walkMiles,                                 // walks with Blu; blank for workouts
    };
    enqueueSession(session);
    draft.sentSessionSig = sessionSig;
    state.sessions = [{ ...session, timestamp: new Date().toISOString() }]
      .concat(state.sessions.filter(s => s.client_id !== session.client_id));
    sessionQueued = true;
  }
  draft.week = week;
  draft.lastSavedAt = new Date().toISOString();
  if (opts.persist !== false) saveDraft(draft);
  persistBootstrapCache();
  return { setsQueued: sets.length, sessionQueued };
}

// What Finish did, for the card on Home: minutes, sets, and every weight that beat last time.
function finishSummary(draft, workout) {
  const p = setProgress(draft, workout);
  const ups = [];
  workout.blocks.forEach(b => {
    const n = b.sets === null ? 0 : Number(b.sets);
    if (n <= 0) return;
    b.exercises.forEach(row => {
      if (!row.log_weight) return;
      let best = null;
      let prev = null;
      for (let i = 1; i <= n; i++) {
        const s = draft.sets[setKey(row.exercise, i)];
        if (!s) continue;
        if (s.done && s.weight !== null && s.weight !== undefined && (best === null || Number(s.weight) > best)) best = Number(s.weight);
        if (s.prevWeight !== null && s.prevWeight !== undefined && (prev === null || Number(s.prevWeight) > prev)) prev = Number(s.prevWeight);
      }
      if (best !== null && prev !== null && best > prev) ups.push({ exercise: row.exercise, from: prev, to: best });
    });
  });
  const walk = draft.dayId === WALK_ID ? walkEntry(draft) : null;
  return { sessionId: draft.sessionClientId, dayId: draft.dayId, week: draft.week || state.week,
    durationMin: draft.durationMin || null, distanceMi: walk && walk.distance ? Number(walk.distance) : null,
    done: p.done, total: p.total, ups };
}

// ---- background save ------------------------------------------------------------------
// Every change (a tick, a weight, the note, a swap, the timer) is sent AUTOSAVE_MS after the last
// one; leaving the page or hiding the app sends at once. Nothing waits for a Save button any more.
let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosaveNow, AUTOSAVE_MS);
}
async function autosaveNow() {
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  if (!current) return;
  const { draft, workout } = current;
  const r = saveWorkout(draft, workout, false);
  if (!r.setsQueued && !r.sessionQueued) { refreshSaveStatus(); return; }
  setSaveStatus(saveStatusText(draft, workout, 'saving…'));
  await flushQueue();
  refreshSaveStatus();
}

// ------------------------------------------------------------------------------- 7. views
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtNum(n) {
  if (n === null || n === undefined || n === '') return '';
  const x = Number(n);
  return isNaN(x) ? String(n) : String(Math.round(x * 100) / 100);
}
// "Tue 11/04" from a YYYY-MM-DD date, read as local. Only the Done-this-week cards show a date
// (Ryan's call, November 4, 2026); everywhere else the app sticks to week and day.
function fmtDayDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + m[2] + '/' + m[3];
}
// "just now", "12 min ago", "3 hours ago", "2 days ago" — relative wording instead of dates.
function fmtAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (isNaN(mins) || mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + ' hour' + (hours === 1 ? '' : 's') + ' ago';
  const days = Math.round(hours / 24);
  return days + ' day' + (days === 1 ? '' : 's') + ' ago';
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function todayIso() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}
function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
function weekLabel() {
  const pi = phaseInfo(phaseForWeek(state.week));
  return 'Week ' + state.week + ' · ' + (pi ? pi.name : 'Phase ' + phaseForWeek(state.week));
}
function friendlyError(err) {
  if (err === 'unauthorized') return 'the script says the token is wrong';
  if (err === 'network') return 'no connection';
  return String(err || '').replace(/^Error:\s*/, '').slice(0, 120);
}

function suggestBanner(sug) {
  return '<div class="suggest"><span>' + esc(sug.text) + '</span><span class="suggest-actions">' +
    '<button type="button" class="btn small primary" data-action="accept-week" data-week="' + sug.next + '" data-sid="' + esc(sug.sessionId) + '">Start Week ' + sug.next + '</button>' +
    '<button type="button" class="btn small ghost" data-action="dismiss-week" data-sid="' + esc(sug.sessionId) + '">Not yet</button>' +
    '</span></div>';
}

// ---- Home ---------------------------------------------------------------------------
function homeView() {
  const next = nextUpDayId();
  const sug = weekSuggestion('home');
  const pj = state.programJson || {};
  const rest = (pj.rest_days || ['Wednesday', 'Sunday']).join(' and ');
  const restNote = (pj.rest_day_note || 'Rest day — walk Blu.').replace(/^Rest day\s*[—-]\s*/i, '');

  const doneIds = DAY_ORDER.filter(d => doneThisWeek(d));
  const allDone = doneIds.length === DAY_ORDER.length;
  const going = inProgressDraft();                       // today's half-done workout, if any
  const bigId = going ? going.dayId : next;
  const todoIds = DAY_ORDER.filter(d => d !== bigId && !doneThisWeek(d));

  const dayButton = (dayId, big) => {
    const m = dayMeta(dayId);
    const optional = dayId === 'day4' ? '<span class="tag">optional in a busy week</span>' : '';
    if (big && going) {
      const p = setProgress(going, effectiveWorkout(workoutFor(going.phase, going.dayId), going));
      const meta = (p.total ? p.done + ' of ' + p.total + ' sets done' : 'in progress') + (timerRunning(going) ? ' · timer running' : '');
      return '<a class="next-up continue" href="#workout/' + dayId + '">' +
        '<span class="eyebrow">Continue where you left off</span>' +
        '<span class="big">' + esc(m.day_label) + ' · ' + esc(m.focus) + '</span>' +
        '<span class="meta">' + esc(meta) + '</span></a>';
    }
    if (big) {
      return '<a class="next-up" href="#workout/' + dayId + '">' +
        '<span class="eyebrow">' + (allDone ? 'Next week starts with' : 'Next up') + '</span>' +
        '<span class="big">' + esc(m.day_label) + ' · ' + esc(m.focus) + '</span>' +
        '<span class="meta">~' + esc(m.minutes || '?') + ' min</span>' + optional +
        '</a>';
    }
    return '<a class="day-btn" href="#workout/' + dayId + '">' +
      '<span><strong>' + esc(m.day_label) + '</strong> · ' + esc(m.focus) + optional + '</span>' +
      '<span class="day-meta">~' + esc(m.minutes || '?') + ' min</span>' +
      '</a>';
  };

  let html = '<section class="home">' +
    '<div class="week-row"><div class="week-label">' + esc(weekLabel()) + '</div>' +
    '<div class="stepper-wrap"><span class="stepper-label" id="week-stepper-label">Change week</span>' +
    '<div class="stepper" role="group" aria-labelledby="week-stepper-label">' +
    '<button type="button" data-action="week-minus" aria-label="Previous week">−</button>' +
    '<button type="button" data-action="week-plus" aria-label="Next week">+</button></div></div></div>';
  const wn = weekNote(state.week);
  if (wn) html += '<p class="week-note">' + esc(wn) + '</p>';
  staleDrafts().forEach(d => { html += recoveryBanner(d); });
  const summary = lsGet(LS.summary, null);
  if (summary && !going) html += summaryCard(summary);
  if (sug) html += suggestBanner(sug);
  html += dayButton(bigId, true);
  if (todoIds.length) {
    html += '<p class="muted small" style="margin:14px 0 4px">' + (going ? 'Or pick another day:' : 'Or pick another day — slide, don\'t skip:') + '</p>';
    todoIds.forEach(d => { html += dayButton(d, false); });
  } else if (allDone && !going) {
    html += '<p class="muted small" style="margin:14px 0 4px">All four days are done — rest up and start the next week when you\'re ready.</p>';
  }
  html += '<p class="rest-note">' + esc(rest) + ': rest — ' + esc(restNote) + '</p>';
  html += '<a class="day-btn walk-btn" href="#workout/' + WALK_ID + '">' +
    '<span><strong>Walk with Blu</strong> · log a walk</span><span class="day-meta">any day</span></a>';
  const walks = walksThisWeek();
  if (doneIds.length || walks.length) html += doneSection(doneIds, walks);

  if (!apiConfigured()) {
    html += '<p class="sync-line warn">Not connected to the sheet yet — saves stay on this phone.</p>';
  } else if (state.queueCount) {
    html += '<p class="sync-line">' + state.queueCount + ' save' + (state.queueCount === 1 ? '' : 's') +
      ' waiting to sync <button type="button" class="link" data-action="retry-sync">Retry</button></p>';
  } else if (state.programSource === 'fallback') {
    html += '<p class="sync-line">Couldn\'t reach the sheet — showing the built-in program.</p>';
  }
  return html + '</section>';
}

// The bottom of Home: this week's completed days, checked off in green, with a line that scales
// with the count ("three days is a win" is the program's own rule).
// Each card carries its weekday and date ("Tue 11/04") on the right; walks with Blu list after the days.
function doneSection(dayIds, walks) {
  const n = dayIds.length;
  const cheer = n >= 4 ? 'All four. A full week — nice work!'
    : n === 3 ? 'Three done — that\'s a win.'
    : n === 2 ? 'Two done — a good week already.'
    : n === 1 ? 'One down — showing up is the hard part.'
    : 'Walks count too — the gym days are still to come.';
  const card = (href, titleHtml, meta, date) => '<a class="day-btn day-done" href="' + href + '">' +
    '<span class="done-badge" aria-hidden="true">✓</span>' +
    '<span class="done-text">' + titleHtml + (meta ? '<br><span class="done-meta">' + esc(meta) + '</span>' : '') + '</span>' +
    '<span class="done-date">' + esc(fmtDayDate(date)) + '</span></a>';
  const walkCount = walks.length ? ' · ' + walks.length + ' walk' + (walks.length === 1 ? '' : 's') : '';
  let html = '<section class="done-week" aria-label="Done this week">' +
    '<div class="done-head"><h3>Done this week</h3><span class="done-count">' + n + ' of ' + DAY_ORDER.length + walkCount + '</span></div>' +
    '<p class="done-cheer">' + esc(cheer) + '</p>';
  dayIds.forEach(d => {
    const s = doneThisWeek(d);
    const m = dayMeta(d);
    html += card('#workout/' + d, '<strong>' + esc(m.day_label) + '</strong> · ' + esc(m.focus), s.duration_min ? s.duration_min + ' min' : '', s.date);
  });
  walks.forEach(s => {
    const bits = [];
    if (s.duration_min) bits.push(s.duration_min + ' min');
    if (s.distance_mi) bits.push(fmtNum(s.distance_mi) + ' mi');
    html += card('#session/' + encodeURIComponent(s.client_id), '<strong>Walk with Blu</strong>', bits.join(' · '), s.date);
  });
  return html + '</section>';
}

// An unfinished workout from another day: finish it (its sets and session land in the sheet and
// "Next up" moves on) or let it go.
function recoveryBanner(d) {
  const m = dayMeta(d.dayId);
  const n = Object.values(d.sets || {}).filter(s => s.done).length;
  const what = n ? n + ' set' + (n === 1 ? '' : 's') + ' on ' + m.day_label : 'a start on ' + m.day_label;
  return '<div class="suggest recover"><span>You logged ' + esc(what) + ' but didn\'t finish it.</span>' +
    '<span class="suggest-actions">' +
    '<button type="button" class="btn small primary" data-action="recover-finish" data-sid="' + esc(d.sessionClientId) + '">Finish it</button>' +
    '<button type="button" class="btn small ghost" data-action="recover-discard" data-sid="' + esc(d.sessionClientId) + '">Discard</button>' +
    '</span></div>';
}

// The card after Finish: how long, how many sets, and which weights beat last time.
function summaryCard(s) {
  const m = dayMeta(s.dayId);
  const bits = [];
  if (s.durationMin) bits.push(s.durationMin + ' min');
  if (s.distanceMi) bits.push(fmtNum(s.distanceMi) + ' mi');
  if (s.total) bits.push(s.done + ' of ' + s.total + ' sets');
  let html = '<section class="summary" aria-label="Last workout">' +
    '<div class="summary-head"><h3>' + esc(m.day_label) + ' done — nice work!</h3>' +
    '<button type="button" class="summary-close" data-action="dismiss-summary" aria-label="Dismiss">✕</button></div>' +
    (bits.length ? '<p class="summary-meta">' + esc(bits.join(' · ')) + '</p>' : '');
  if (s.ups && s.ups.length) {
    html += '<p class="summary-ups"><strong>Went up:</strong> ' +
      s.ups.map(u => esc(u.exercise) + ' ' + esc(fmtNum(u.from)) + ' → ' + esc(fmtNum(u.to)) + ' lb').join(', ') + '</p>';
  } else if (s.total) {
    html += '<p class="summary-ups muted">Same weights as last time — go up where every set hit the top of the range.</p>';
  }
  return html + '</section>';
}

// ---- Workout ------------------------------------------------------------------------
function workoutView(dayId) {
  const phase = phaseForWeek(state.week);
  const draft = loadDraft(dayId, phase);
  const workout = effectiveWorkout(workoutFor(phase, dayId), draft);   // today's swaps applied
  current = { draft, workout };
  const m = dayMeta(dayId);
  const pi = phaseInfo(phase);
  const sug = weekSuggestion('workout', dayId);

  let html = '<section class="workout">' +
    '<h2 class="day-title">' + esc(m.day_label) + ' · ' + esc(m.focus) + '</h2>' +
    '<p class="day-sub">' + esc(weekLabel()) + (m.minutes ? ' · ~' + esc(m.minutes) + ' min' : '') + '</p>' +
    timerCard(draft);
  if (timerRunning(draft)) startTick(); else stopTick();
  if (sug) html += suggestBanner(sug);
  if (dayId !== WALK_ID) {                      // a walk has no phase banner or week note
    if (pi && pi.banner) {
      const head = pi.banner.split(' — ')[0];
      html += '<details class="banner"><summary>' + esc(head) + '</summary><p>' + esc(pi.banner) + '</p></details>';
    }
    const wn = weekNote(state.week);
    if (wn) html += '<p class="week-note">' + esc(wn) + '</p>';
  }
  if (!workout.blocks.length) {
    html += '<p class="empty">No exercises found for ' + esc(m.day_label) + ' in Phase ' + phase + '. Check the Program tab.</p>';
  }
  workout.blocks.forEach(b => { html += blockCard(b, draft); });
  if (workout.cooldown) html += '<p class="cooldown">' + esc(workout.cooldown) + '</p>';
  html += '<section class="card notes-card"><h3>Notes</h3>' +
    '<textarea id="day-note" class="notes" rows="3" placeholder="How did it go? Anything to remember next time?"' +
    ' aria-label="Notes for this workout">' + esc(draft.note || '') + '</textarea></section>';
  const p = setProgress(draft, workout);
  const allDone = p.total > 0 && p.done >= p.total;
  html += '</section>' +
    '<div id="savebar" class="savebar' + (allDone ? ' all-done' : '') + '"><div class="savebar-inner">' +
    '<div id="save-status" class="save-status">' + esc(saveStatusText(draft, workout)) + '</div>' +
    '<button type="button" class="btn primary finish" data-action="finish">' +
    (draft.completed ? 'Finished ✓ · update' : dayId === WALK_ID ? 'Log this walk' : 'Finish workout') + '</button>' +
    '</div></div>';
  saveDraft(draft);                            // persist the entries prefill just created
  return html;
}

// The line above the Finish button: progress first, then where the data is.
function saveStatusText(draft, workout, syncing) {
  const p = setProgress(draft, workout);
  if (!draft.completed && p.total > 0 && p.done >= p.total) return 'That\'s everything — finish workout?';
  const progress = p.total ? p.done + ' of ' + p.total + ' sets done'
    : draft.dayId === WALK_ID ? (Object.values(draft.cardio || {}).some(c => c.done) ? 'walk ticked ✓' : 'minutes and miles, then ✓')
    : 'nothing to count';
  const base = (draft.completed ? 'Finished ✓ · ' : '') + progress;
  if (syncing) return base + ' · ' + syncing;
  if (state.queueCount) return base + ' · ' + (apiConfigured() ? 'saved on this phone, will sync' : 'saved on this phone');
  if (draft.lastSavedAt) return base + ' · saved ✓';
  return base;
}
function refreshSaveStatus() {
  if (!current) return;
  const { draft, workout } = current;
  setSaveStatus(saveStatusText(draft, workout));
  const bar = document.getElementById('savebar');
  const p = setProgress(draft, workout);
  if (bar) bar.classList.toggle('all-done', !draft.completed && p.total > 0 && p.done >= p.total);
}

function blockCard(b, draft) {
  const n = b.sets === null ? 0 : Number(b.sets);
  const hint = b.block_type === 'superset' ? 'A then B, rest 45–60 sec'
    : b.block_type === 'circuit' ? 'All four back to back, rest 60–90 sec'
    : b.block_type === 'abs' ? 'Back to back, rest 60 sec between rounds'
    : b.block_type === 'stretch' ? 'Hold each one and breathe — the ⏱ times a hold for you'
    : b.block_type === 'walk' ? 'Minutes and miles. Start the timer at the door, or type them in after.'
    : '';
  let html = '<section class="card block block-' + esc(b.block_type) + '"><h3>' + esc(b.block) + '</h3>' +
    (hint ? '<p class="hint">' + esc(hint) + '</p>' : '');
  b.exercises.forEach(row => {
    if (n > 0) { html += exerciseSets(row, n, draft); return; }
    if (!isCardioRow(row, b)) { html += checkLine(row, b, draft); return; }
    html += cardioLine(row, b, draft);
    if (b.block_type === 'warmup') {               // "+ Add cardio": optional extra lines under the warm-up slot
      extraCardio(draft, row.exercise).forEach(c => { html += cardioLine(row, b, draft, c); });
      html += '<button type="button" class="btn ghost small add-cardio" data-action="add-cardio" data-slot="' + esc(row.exercise) + '">+ Add cardio</button>';
    }
  });
  return html + '</section>';
}

function targetText(row) {
  const t = String(row.target || '');
  return (row.unit === 'reps' || !row.unit) && /^[\d–—-]+$/.test(t) ? t + ' reps' : t;
}

// "2 of 3 ✓" next to the fold button: green once every set of the exercise is ticked.
function exerciseBadge(draft, row, n) {
  const p = exerciseProgress(draft, row, n);
  const all = p.total > 0 && p.done >= p.total;
  return '<span class="ex-badge' + (all ? ' all' : '') + '" data-badge="' + esc(row.exercise) + '">' +
    p.done + ' of ' + p.total + (all ? ' ✓' : '') + '</span>';
}

function exerciseSets(row, n, draft) {
  const unit = unitLabel(row.unit);
  const last = lastTimeText(row, draft.date);
  const nudge = nudgeFor(row, draft.date);
  const folded = !!(draft.collapsed && draft.collapsed[row.exercise]);
  // Name with "▶ how to" right after it and a fold button at the end of the line; everything else
  // (links, last time, the set rows) is in .ex-body, which the fold hides. "history" sits on its own
  // line under the name; the rep target sits over the reps column in a header row that uses the
  // same grid as the set rows.
  const slot = row.swapped_from || row.exercise;             // the Program exercise this row stands for
  let sub = '<a class="ex-history" href="#exercise/' + encodeURIComponent(row.exercise) + '">history</a>';
  if (hasLibrary()) {
    const opts = swapOptions(slot, current && current.workout);
    if (opts.same.length || opts.more.length || row.swapped_from) {
      sub += '<button type="button" class="ex-link ex-swap" data-action="swap" data-slot="' + esc(slot) + '">swap</button>';
    }
    sub += favButton(row.exercise);
  }
  let html = '<div class="exercise' + (folded ? ' is-collapsed' : '') + '" data-exercise="' + esc(row.exercise) + '">' +
    '<div class="ex-head"><span class="ex-title"><span class="ex-name">' + esc(row.exercise) + '</span>' + videoLink(row.exercise) + '</span>' +
    exerciseBadge(draft, row, n) +
    '<button type="button" class="ex-toggle" data-action="toggle-ex" data-exercise="' + esc(row.exercise) + '"' +
    ' aria-expanded="' + (folded ? 'false' : 'true') + '" aria-label="' + (folded ? 'Show' : 'Hide') + ' the sets for ' + esc(row.exercise) + '">' +
    '<span class="ex-chev" aria-hidden="true">›</span></button></div>' +
    '<div class="ex-body">' +
    '<div class="ex-sub">' + sub + '</div>';
  if (row.swapped_from) {
    html += '<div class="ex-swapped">in place of ' + esc(row.swapped_from) +
      ' · <button type="button" class="ex-link inline" data-action="unswap" data-slot="' + esc(row.swapped_from) + '">undo</button></div>';
  }
  if (last) html += '<div class="ex-last">last time: ' + esc(last) + '</div>';
  if (nudge) html += '<div class="ex-nudge">' + esc(nudge) + '</div>';
  if (row.note) html += '<div class="ex-note">' + esc(row.note) + '</div>';
  // Each set row is its own grid, so the header repeats the unit labels (invisibly) to get the
  // same column widths and land the target exactly over the reps field.
  html += '<div class="set-row set-head"><span></span><span></span>' +
    '<span class="unit head-unit">' + (row.log_weight ? 'lb' : '') + '</span>' +
    '<span class="ex-target">' + esc(targetText(row)) + '</span>' +
    '<span class="unit head-unit">' + esc(unit) + '</span><span></span></div>';
  const hint = row.log_weight ? startWeightHint(row.exercise) : '';   // "15–20" / "pin" until there is history
  for (let i = 1; i <= n; i++) {
    const s = getSetEntry(draft, row, i);
    const key = setKey(row.exercise, i);
    const label = esc(row.exercise) + ' set ' + i;
    const faint = !s.done && !s.touched ? ' in-hint' : '';         // suggested values look faint until she acts on them
    const timed = row.unit === 'time';                                  // seconds: the ⏱ can fill them in
    const timerBtn = cls => '<button type="button" class="' + cls + '" data-action="set-timer" data-kind="set" data-key="' + esc(key) + '"' +
      ' aria-label="Time ' + label + '">⏱' + (cls.includes('in-timer') ? ' Start' : ' ' + i) + '</button>';
    html += '<div class="set-row' + (s.done ? ' is-done' : '') + '" data-row="' + esc(key) + '">' +
      (timed && row.log_weight ? timerBtn('set-label set-label-timer') : '<span class="set-label">Set ' + i + '</span>');
    if (row.log_weight) {
      html += '<input class="in in-weight' + faint + '" type="text" inputmode="decimal" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="next"' +
        ' placeholder="' + esc(hint) + '" value="' + esc(fmtNum(s.weight)) + '" data-key="' + esc(key) + '" data-field="weight" aria-label="' + label + ' weight">' +
        '<span class="unit">lb</span>';
    } else if (timed) {
      html += timerBtn('in in-timer') + '<span class="unit"></span>';
    } else {
      html += '<span class="in in-bw" title="bodyweight">BW</span><span class="unit"></span>';
    }
    html += '<input class="in in-reps' + faint + '" type="text" inputmode="numeric" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="next" placeholder=""' +
      ' value="' + esc(s.reps === null || s.reps === undefined ? '' : s.reps) + '" data-key="' + esc(key) + '" data-field="reps" aria-label="' + label + ' ' + esc(unit) + '">' +
      '<span class="unit">' + esc(unit) + '</span>' +
      '<button type="button" class="done" data-key="' + esc(key) + '" aria-pressed="' + (s.done ? 'true' : 'false') + '" aria-label="' + label + ' done">✓</button>' +
      '</div>';
  }
  return html + '</div></div>';
}

// After a tick: redraw that exercise's "n of m" badge without re-rendering the page.
function refreshExerciseBadge(exerciseName) {
  if (!current) return;
  const { draft, workout } = current;
  const blocks = workout.blocks;
  for (const b of blocks) {
    const n = b.sets === null ? 0 : Number(b.sets);
    const row = b.exercises.find(r => r.exercise === exerciseName);
    if (!row || n <= 0) continue;
    const old = document.querySelector('.ex-badge[data-badge="' + CSS.escape(exerciseName) + '"]');
    if (old) old.outerHTML = exerciseBadge(draft, row, n);
    return;
  }
}

// A single line with a tick: warm-up moves and the stretch block. Timed lines (unit = time) get a ⏱
// that fills in the seconds; stretches can be swapped for another one from the library.
function checkLine(row, block, draft) {
  const on = !!draft.checks[row.exercise];
  const secs = draft.checkSecs ? draft.checkSecs[row.exercise] : undefined;
  const timed = row.unit === 'time';
  const slot = row.swapped_from || row.exercise;
  let tools = '';
  if (block.block_type === 'stretch' && hasLibrary()) {
    const opts = swapOptions(slot, current && current.workout);
    if (opts.same.length || opts.more.length || row.swapped_from) {
      tools += '<button type="button" class="ex-link inline" data-action="swap" data-slot="' + esc(slot) + '">swap</button>';
    }
  }
  if (row.swapped_from) {
    tools += '<span class="ex-swapped">in place of ' + esc(row.swapped_from) +
      ' · <button type="button" class="ex-link inline" data-action="unswap" data-slot="' + esc(row.swapped_from) + '">undo</button></span>';
  }
  return '<div class="exercise check-line' + (on ? ' is-done' : '') + '" data-check-line="' + esc(row.exercise) + '">' +
    '<button type="button" class="done" data-check="' + esc(row.exercise) + '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + esc(row.exercise) + ' done">✓</button>' +
    '<span class="check-text"><span class="ex-head"><span class="ex-name">' + esc(row.exercise) + '</span>' + videoLink(row.exercise) + '</span>' +
    '<span class="ex-target">' + esc(row.target) +
    (secs !== undefined && secs !== null ? ' · <span class="check-secs">' + esc(secs) + ' sec logged</span>' : '') + '</span>' +
    (row.note ? '<span class="ex-note">' + esc(row.note) + '</span>' : '') +
    (tools ? '<span class="check-tools">' + tools + '</span>' : '') + '</span>' +
    (timed ? '<button type="button" class="line-timer" data-action="set-timer" data-kind="check" data-name="' + esc(row.exercise) + '"' +
      ' aria-label="Time ' + esc(row.exercise) + '">⏱</button>' : '') +
    '</div>';
}

// The cardio line (warm-up, finisher, walk): which machine, then minutes · miles · kcal, a ⏱ and a ✓.
// Logged as one Log row with the machine in `exercise` and the Program slot in `swapped_from`.
// `extra` is one of the warm-up's "+ Add cardio" entries: same line, labelled "Extra cardio", with
// a remove link instead of the target; it logs as set 2, 3, … of its machine.
function cardioLine(row, block, draft, extra) {
  const withSelect = block.block_type !== 'walk';
  const c = extra || getCardioEntry(draft, row, withSelect);
  const slot = c.slot || row.exercise;                      // the Program slot, or "<slot>#2" for an extra line
  const isExtra = (c.setNumber || 1) > 1;
  const faint = !c.done && !c.touched ? ' in-hint' : '';
  const le = cardioLastFor(c, draft.date);
  const last = le ? cardioSummary(le) : '';
  let head;
  if (withSelect) {
    const machines = cardioMachines();
    if (!machines.includes(c.machine)) machines.unshift(c.machine);
    head = '<select class="in in-select" data-cardio-machine="' + esc(slot) + '" aria-label="Cardio machine">' +
      machines.map(m => '<option value="' + esc(m) + '"' + (m === c.machine ? ' selected' : '') + '>' + esc(m) + '</option>').join('') + '</select>';
  } else {
    head = '<span class="ex-name cardio-name">' + esc(row.exercise) + '</span>';
  }
  const field = (name, value, unit, mode, label) =>
    '<label class="cardio-field"><input class="in in-cardio' + faint + '" type="text" inputmode="' + mode + '" autocomplete="off" enterkeyhint="next"' +
    ' value="' + esc(fmtNum(value)) + '" data-cardio-field="' + name + '" data-slot="' + esc(slot) + '" aria-label="' + esc(c.machine) + ' ' + label + '">' +
    '<span class="unit">' + unit + '</span></label>';
  const history = '<a class="ex-history inline" href="#exercise/' + encodeURIComponent(c.machine) + '">history</a>';
  const sub = isExtra
    ? 'Extra cardio · ' + history + ' · <button type="button" class="ex-link inline" data-action="remove-cardio" data-slot="' + esc(slot) + '">remove</button>'
    : esc(row.target) + (row.note ? ' · ' + esc(row.note) : '') + ' · ' + history;
  return '<div class="exercise cardio-line' + (c.done ? ' is-done' : '') + (isExtra ? ' cardio-extra' : '') + '" data-cardio="' + esc(slot) + '">' +
    '<div class="cardio-head">' + head +
    '<button type="button" class="line-timer" data-action="set-timer" data-kind="cardio" data-slot="' + esc(slot) + '" aria-label="Time this">⏱</button>' +
    '<button type="button" class="done" data-cardio-done="' + esc(slot) + '" aria-pressed="' + (c.done ? 'true' : 'false') + '" aria-label="' + esc(c.machine) + ' done">✓</button></div>' +
    '<div class="cardio-sub">' + sub + (last ? '<br>last time: ' + esc(last) : '') + '</div>' +
    '<div class="cardio-fields">' +
    field('minutes', c.minutes, 'min', 'decimal', 'minutes') + field('distance', c.distance, 'mi', 'decimal', 'miles') +
    field('calories', c.calories, 'kcal', 'numeric', 'calories') + '</div></div>';
}

function favButton(name) {
  const on = isFavorite(name);
  return '<button type="button" class="ex-fav" data-action="fav" data-exercise="' + esc(name) + '"' +
    ' aria-pressed="' + (on ? 'true' : 'false') + '"' +
    ' aria-label="' + (on ? 'Remove ' + esc(name) + ' from favorites' : 'Mark ' + esc(name) + ' as a favorite') + '">' +
    (on ? '★ favorite' : '☆ favorite') + '</button>';
}

// ---- Swap picker (a bottom sheet over the workout) --------------------------------------
function openSwapSheet(slot) {
  if (!current) return;
  const { workout } = current;
  const opts = swapOptions(slot, workout);
  const rowNow = workout.blocks.flatMap(b => b.exercises).find(r => (r.swapped_from || r.exercise) === slot);
  const nameNow = rowNow ? rowNow.exercise : slot;
  const item = e => '<div class="pick-row">' +
    '<button type="button" class="pick" data-action="pick-swap" data-slot="' + esc(slot) + '" data-exercise="' + esc(e.exercise) + '">' +
    '<span class="pick-name">' + (isFavorite(e.exercise) ? '★ ' : '') + esc(e.exercise) + '</span>' +
    '<span class="pick-meta">' + esc(e.target || '') + (e.log_weight ? '' : ' · bodyweight') + (e.note ? ' · ' + esc(e.note) : '') + '</span>' +
    '</button>' + videoLink(e.exercise) + '</div>';
  let body = '';
  if (!opts.slot) {
    body = '<p class="muted">' + esc(slot) + ' isn\'t in the Exercises tab yet, so there is nothing to swap it for.</p>';
  } else {
    if (opts.same.length) body += '<h4>Same type · ' + esc(opts.slot.category) + '</h4>' + opts.same.map(item).join('');
    if (opts.more.length) body += '<h4>More ' + esc(opts.slot.body_part) + '</h4>' + opts.more.map(item).join('');
    if (!opts.same.length && !opts.more.length) body += '<p class="muted">Every other ' + esc(opts.slot.body_part) + ' exercise is already in today\'s workout.</p>';
  }
  const back = nameNow !== slot
    ? '<button type="button" class="btn ghost" data-action="unswap" data-slot="' + esc(slot) + '">Back to ' + esc(slot) + '</button>'
    : '';
  const sheet = document.getElementById('sheet');
  sheet.innerHTML = '<button type="button" class="sheet-backdrop" data-action="close-sheet" aria-label="Close"></button>' +
    '<div class="sheet" role="dialog" aria-modal="true" aria-label="Swap ' + esc(nameNow) + '">' +
    '<h3>Swap ' + esc(nameNow) + '</h3>' +
    (opts.slot ? '<p class="muted small">' + esc(opts.slot.body_part) + ' · ' + esc(opts.slot.category) + ' · favorites first</p>' : '') +
    '<div class="sheet-body">' + body + '</div>' +
    '<div class="sheet-actions">' + back +
    '<button type="button" class="btn ghost" data-action="close-sheet">Cancel</button></div></div>';
  sheet.hidden = false;
  document.body.classList.add('sheet-open');
}

function closeSheet() {
  const sheet = document.getElementById('sheet');
  if (!sheet || sheet.hidden) return;
  sheet.hidden = true;
  sheet.innerHTML = '';
  document.body.classList.remove('sheet-open');
}

// Swap a slot for `exercise` (or back to the Program exercise when null), then redraw in place.
function applySwap(slot, exercise) {
  if (!current) return;
  const draft = current.draft;
  if (!draft.swaps) draft.swaps = {};
  if (!exercise || libKey(exercise) === libKey(slot)) delete draft.swaps[slot];
  else draft.swaps[slot] = exercise;
  markStarted(draft);
  draft.lastActivityAt = new Date().toISOString();
  saveDraft(draft);
  closeSheet();
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
  scheduleAutosave();
}

// ---- History ------------------------------------------------------------------------
function historyView() {
  if (!state.sessions.length) return '<p class="empty">No workouts logged yet. The first one will show up here.</p>';
  const pending = queuedSessionIds();
  const items = state.sessions.slice(0, 60).map(s => {
    const m = dayMeta(s.day_id);
    const status = isTrue(s.completed) ? 'Completed' : 'Not finished';
    const local = pending.has(s.client_id) ? ' · not synced yet' : '';
    const noteText = String(s.note || '').trim();
    const noteLine = noteText
      ? '<br><span class="small note-preview">' + esc(noteText.length > 90 ? noteText.slice(0, 90) + '…' : noteText) + '</span>'
      : '';
    const mins = (s.duration_min ? ' · ' + esc(s.duration_min) + ' min' : '') + (s.distance_mi ? ' · ' + esc(fmtNum(s.distance_mi)) + ' mi' : '');
    return '<a class="row" href="#session/' + encodeURIComponent(s.client_id) + '">' +
      '<span><strong>' + esc(m.day_label) + '</strong> · ' + esc(m.focus) + '<br>' +
      '<span class="muted small">Week ' + esc(s.week) + ' · ' + status + mins + local + '</span>' + noteLine + '</span>' +
      '<span class="chev">›</span></a>';
  }).join('');
  return '<section class="list">' + items + '</section>';
}

// ---- Session detail -----------------------------------------------------------------
function sessionView(id) {
  const s = state.sessions.find(x => x.client_id === id);
  if (!s) return '<p class="empty">Couldn\'t find that session.</p>';
  const m = dayMeta(s.day_id);
  return '<section class="session">' +
    '<h2 class="day-title">' + esc(m.day_label) + ' · ' + esc(m.focus) + '</h2>' +
    '<p class="day-sub">Week ' + esc(s.week) + ' · ' +
    (isTrue(s.completed) ? 'Completed' : 'Not finished') +
    (s.duration_min ? ' · ' + esc(s.duration_min) + ' min' : '') +
    (s.distance_mi ? ' · ' + esc(fmtNum(s.distance_mi)) + ' mi' : '') + '</p>' +
    (s.timer_start ? '<p class="day-sub">Timer: ' + esc(fmtTime(s.timer_start)) +
      (s.timer_end ? ' – ' + esc(fmtTime(s.timer_end)) : ' (still running)') + '</p>' : '') +
    (String(s.note || '').trim() ? '<p class="session-note">' + esc(String(s.note).trim()) + '</p>' : '') +
    '<div id="session-sets"><p class="muted">Loading sets…</p></div></section>';
}

async function loadSessionSets(route, s) {
  let note = '';
  let serverRows = [];
  if (apiConfigured()) {
    try {
      const res = await apiGet({ action: 'sets', date: s.date, day_id: s.day_id });
      if (res && res.ok) serverRows = res.rows || [];
      else if (/unknown action/.test(String(res && res.error))) note = 'Update the script to the latest Code.gs to see set details.';
      else note = 'Couldn\'t load the sets from the sheet right now.';
    } catch (e) {
      note = 'Couldn\'t load the sets from the sheet right now.';
    }
  }
  if (state.route !== route) return;                 // user moved on
  const localRows = queuedSetRows(r => r.date === s.date && r.day_id === s.day_id);
  const box = document.getElementById('session-sets');
  if (box) box.innerHTML = renderSessionSets(s, serverRows.concat(localRows), note);
}

function setText(s, row, unit) {
  if (hasCardioNumbers(s)) return cardioSummary(s);           // a cardio row: minutes · miles · kcal
  const w = (s.weight === '' || s.weight === null || s.weight === undefined) ? null : Number(s.weight);
  const r = (s.reps === '' || s.reps === null || s.reps === undefined) ? null : s.reps;
  if (w === null && r === null) return 'done';
  const parts = [];
  if (w !== null) parts.push(fmtNum(w) + ' lb');
  else if (!row || !row.log_weight) parts.push('BW');
  if (r !== null) parts.push((typeof r === 'number' ? fmtNum(r) : String(r)) + ' ' + unit);
  return parts.join(' × ');
}

function renderSessionSets(session, rows, note) {
  const latest = new Map();                                   // "exercise|set" → row; later rows win
  rows.forEach(r => latest.set(setKey(r.exercise, Number(r.set_number) || 1), r));
  const phase = Number(session.phase) || phaseForWeek(Number(session.week) || 1);
  const order = [];
  workoutFor(phase, session.day_id).blocks.forEach(b => b.exercises.forEach(e => order.push(e)));
  const byExercise = new Map();
  latest.forEach(r => {
    if (!byExercise.has(r.exercise)) byExercise.set(r.exercise, []);
    byExercise.get(r.exercise).push(r);
  });
  const names = order.map(e => e.exercise).filter(n => byExercise.has(n))
    .concat([...byExercise.keys()].filter(n => !order.some(e => e.exercise === n)));
  if (!names.length) return '<p class="muted">' + esc(note || 'No sets were logged for this session.') + '</p>';
  let html = names.map(n => {
    const row = order.find(e => e.exercise === n);
    const unit = unitLabel(row ? row.unit : 'reps');
    const sets = byExercise.get(n).sort((a, b) => Number(a.set_number) - Number(b.set_number));
    const swappedFrom = String(sets[0].swapped_from || '').trim();
    const isExtra = s => String(s.note || '').trim() === 'extra cardio';      // "+ Add cardio" rows
    const label = sets.every(isExtra) ? 'extra cardio' : swappedFrom ? 'in place of ' + swappedFrom : '';
    return '<div class="card"><h3>' + esc(n) +
      (label ? ' <span class="muted small">' + esc(label) + '</span>' : '') + '</h3>' + sets.map(s =>
      '<div class="set-line"><span>' + (isExtra(s) ? 'Extra' : 'Set ' + esc(s.set_number)) + '</span><span>' + esc(setText(s, row, unit)) + '</span>' +
      '<span class="tick">' + (isTrue(s.done) ? '✓' : '') + '</span></div>').join('') + '</div>';
  }).join('');
  if (note) html += '<p class="muted small">' + esc(note) + '</p>';
  return html;
}

// ---- Exercise history ---------------------------------------------------------------
function exerciseView(name) {
  return '<section class="exercise-history"><h2 class="day-title">' + esc(name) + '</h2>' +
    '<p class="day-sub">Last 10 sessions, newest first' + videoLink(name) + (hasLibrary() ? favButton(name) : '') + '</p>' +
    '<div id="exercise-rows"><p class="muted">Loading…</p></div></section>';
}

async function loadExerciseHistory(route, name) {
  let note = '';
  let server = [];
  if (apiConfigured()) {
    try {
      const res = await apiGet({ action: 'history', exercise: name, limit: 80 });
      if (res && res.ok) server = res.rows || [];
      else note = 'Couldn\'t load history from the sheet right now.';
    } catch (e) {
      note = 'Couldn\'t load history from the sheet right now.';
    }
  }
  if (state.route !== route) return;
  const local = queuedSetRows(r => r.exercise === name).reverse();      // newest first, like the API
  const box = document.getElementById('exercise-rows');
  if (box) box.innerHTML = renderExerciseRows(name, local.concat(server), note);
}

function renderExerciseRows(name, rows, note) {
  const byDate = new Map();                                   // date → Map(set_number → newest row)
  rows.forEach(r => {
    const d = String(r.date || '').slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, new Map());
    const m = byDate.get(d);
    const n = Number(r.set_number) || 1;
    if (!m.has(n)) m.set(n, r);                               // rows arrive newest first
  });
  const dates = [...byDate.keys()].sort().reverse().slice(0, 10);
  if (!dates.length) return '<p class="muted">' + esc(note || 'No history yet for this exercise.') + '</p>';
  const row = state.program.find(r => r.exercise === name) || null;
  let html = '<div class="card">' + dates.map(d => {
    const sets = [...byDate.get(d).values()].sort((a, b) => Number(a.set_number) - Number(b.set_number));
    const dayLabel = sets[0].day_id ? dayMeta(sets[0].day_id).day_label : '';
    return '<div class="set-line"><span>Week ' + esc(sets[0].week || '?') + (dayLabel ? ' · ' + esc(dayLabel) : '') + '</span>' +
      '<span>' + esc(setsSummary(sets, row)) + '</span></div>';
  }).join('') + '</div>';
  if (note) html += '<p class="muted small">' + esc(note) + '</p>';
  return html;
}

// ---- Settings -----------------------------------------------------------------------
function settingsView() {
  const q = state.queueCount;
  const bad = readQueue().find(i => i.lastError);
  const programText = state.programSource === 'fallback'
    ? 'Showing the built-in copy of the program (the sheet has not answered yet).'
    : 'Program from the sheet' + (state.programUpdatedAt ? ', last refreshed ' + fmtAgo(state.programUpdatedAt) : '') + '.';
  const nFav = state.favorites.length;
  const libText = hasLibrary()
    ? state.exercises.length + ' exercises in the swap library · ' + nFav + ' favorite' + (nFav === 1 ? '' : 's') + '.'
    : 'No Exercises tab from the sheet yet — swap and ☆ favorite stay hidden until there is one.';
  return '<section class="settings">' +
    '<div class="card"><h3>Connection</h3><p id="conn-status" class="muted">' +
    (apiConfigured() ? 'Checking…' : 'Not configured — put the script URL and token in web/config.js.') + '</p>' +
    '<button type="button" class="btn ghost" data-action="ping"' + (apiConfigured() ? '' : ' disabled') + '>Test connection</button></div>' +
    '<div class="card"><h3>Sync</h3><p class="muted">' +
    (q ? q + ' save' + (q === 1 ? '' : 's') + ' waiting to sync.' + (bad ? ' Last problem: ' + esc(friendlyError(bad.lastError)) + '.' : '')
       : 'Everything is saved to the sheet.') + '</p>' +
    '<button type="button" class="btn ghost" data-action="retry-sync"' + (q ? '' : ' disabled') + '>Retry queued saves (' + q + ')</button></div>' +
    '<div class="card"><h3>Program</h3><p class="muted">' + esc(programText) + '</p><p class="muted">' + esc(libText) + '</p>' +
    '<button type="button" class="btn ghost" data-action="reload-program"' + (apiConfigured() ? '' : ' disabled') + '>Reload from the sheet</button></div>' +
    '<p class="muted small" style="text-align:center">Shelby\'s Workouts · app v' + APP_VERSION + '</p>' +
    '</section>';
}

async function pingAndShow(route) {
  const el = document.getElementById('conn-status');
  if (!el || !apiConfigured()) return;
  el.textContent = 'Checking…';
  const t0 = performance.now();
  try {
    const res = await apiGet({ action: 'ping' });
    if (state.route !== route) return;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    el.textContent = res && res.ok ? 'Connected · ' + secs + ' s' : 'The script answered but ' + friendlyError(res && res.error) + '.';
  } catch (e) {
    if (state.route !== route) return;
    el.textContent = 'Can\'t reach the script right now.';
  }
}

// ------------------------------------------------------------------------------- 8. routing & events
function parseHash() {
  const h = (location.hash || '#').slice(1).replace(/^\/+/, '');
  const slash = h.indexOf('/');
  const name = slash < 0 ? h : h.slice(0, slash);
  const arg = slash < 0 ? '' : h.slice(slash + 1);
  switch (name) {
    case 'workout': return { name: 'workout', dayId: ALL_DAY_IDS.includes(arg) ? arg : 'day1' };
    case 'history': return { name: 'history' };
    case 'session': return { name: 'session', id: safeDecode(arg) };
    case 'exercise': return { name: 'exercise', exercise: safeDecode(arg) };
    case 'settings': return { name: 'settings' };
    default: return { name: 'home' };
  }
}
function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

function renderTopbar(route) {
  const left = document.getElementById('topbar-left');
  const title = document.getElementById('topbar-title');
  const right = document.getElementById('topbar-right');
  const back = (href, label) => '<a class="topbar-btn" href="' + href + '">‹ ' + label + '</a>';
  const historyLink = '<a class="topbar-btn" href="#history">History</a>';
  // The gear is an inline SVG so it is the same height as the title on every phone (the gear glyph
  // renders small, or as an emoji, depending on the font).
  const settingsLink = '<a class="topbar-btn topbar-gear" href="#settings" aria-label="Settings">' +
    '<svg class="gear" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6a.5.5 0 0 0 .1-.7l-2-3.4a.5.5 0 0 0-.6-.2l-2.5 1a7.3 7.3 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 0-.5.5l-.4 2.6a7.3 7.3 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.4a.5.5 0 0 0 .1.7L4.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6a.5.5 0 0 0-.1.7l2 3.4a.5.5 0 0 0 .6.2l2.5-1a7.3 7.3 0 0 0 1.7 1l.4 2.6a.5.5 0 0 0 .5.5h4a.5.5 0 0 0 .5-.5l.4-2.6a7.3 7.3 0 0 0 1.7-1l2.5 1a.5.5 0 0 0 .6-.2l2-3.4a.5.5 0 0 0-.1-.7L19.4 13zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg></a>';
  switch (route.name) {
    case 'workout':
      left.innerHTML = back('#', 'Home'); title.textContent = weekLabel(); right.innerHTML = historyLink; break;
    case 'history':
      left.innerHTML = back('#', 'Home'); title.textContent = 'History'; right.innerHTML = ''; break;
    case 'session':
      left.innerHTML = back('#history', 'History'); title.textContent = 'Session'; right.innerHTML = ''; break;
    case 'exercise': {
      const from = state.prevHash && state.prevHash.startsWith('#workout/') ? state.prevHash : '#';
      left.innerHTML = back(from, 'Back'); title.textContent = 'Exercise'; right.innerHTML = ''; break;
    }
    case 'settings':
      left.innerHTML = back('#', 'Home'); title.textContent = 'Settings'; right.innerHTML = ''; break;
    default:
      left.innerHTML = historyLink; title.textContent = 'Shelby\'s Workouts'; right.innerHTML = settingsLink;
  }
}

function render() {
  closeSheet();
  stopTick();                                   // the Workout view restarts it when its timer is running
  stopSetTick();
  if (current && autosaveTimer) autosaveNow();  // leaving a workout: send what is pending now, not in 3 s
  const route = parseHash();
  state.route = route;
  if (route.name !== 'workout') current = null;
  document.body.dataset.view = route.name;
  const view = document.getElementById('view');
  switch (route.name) {
    case 'workout': view.innerHTML = workoutView(route.dayId); break;
    case 'history': view.innerHTML = historyView(); break;
    case 'session': {
      view.innerHTML = sessionView(route.id);
      const s = state.sessions.find(x => x.client_id === route.id);
      if (s) loadSessionSets(route, s);
      break;
    }
    case 'exercise': view.innerHTML = exerciseView(route.exercise); loadExerciseHistory(route, route.exercise); break;
    case 'settings': view.innerHTML = settingsView(); pingAndShow(route); break;
    default: view.innerHTML = homeView();
  }
  renderTopbar(route);
  renderSetTimer();                             // the ⏱ clock, when one is running in this workout's draft
  window.scrollTo(0, 0);
}

function rerenderIfPassive() {
  if (state.route.name === 'home' || state.route.name === 'history') render();
}

function setSaveStatus(text) {
  const el = document.getElementById('save-status');
  if (el) el.textContent = text;
}

let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function parseWeight(value) {
  const v = String(value).trim().replace(',', '.');
  if (v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
function parseReps(value) {
  const v = String(value).trim();
  if (v === '') return null;
  const n = Number(v);
  return isNaN(n) ? v : n;
}

// Finish: the one button. Marks the session completed, stops the timer, leaves a summary card on Home.
function onFinish() {
  if (!current) return;
  const { draft, workout } = current;
  const anyDone = Object.values(draft.sets).some(s => s.done) || Object.values(draft.checks).some(Boolean);
  if (!anyDone && !window.confirm('No sets are marked done yet. Finish this workout anyway?')) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  saveWorkout(draft, workout, true);
  lsSet(LS.summary, finishSummary(draft, workout));
  showToast('Saved — nice work!');
  location.hash = '#';                                     // Home shows the summary and the new next-up
  flushQueue().then(rerenderIfPassive);
}

// Finish or drop a workout from another day that was never finished (the banner on Home).
function recoverDraft(sessionId, finish) {
  const d = staleDrafts().find(x => x.sessionClientId === sessionId);
  if (!d) { dropStaleDraft(sessionId); render(); return; }
  if (finish) {
    const workout = effectiveWorkout(workoutFor(d.phase, d.dayId), d);
    const endedAt = d.lastActivityAt || d.startedAt || d.createdAt;
    saveWorkout(d, workout, true, { week: d.week || state.week, endedAt, persist: false });
    showToast(dayMeta(d.dayId).day_label + ' marked finished');
  }
  dropStaleDraft(sessionId);
  render();
  flushQueue().then(rerenderIfPassive);
}

async function handleAction(action, btn) {
  switch (action) {
    case 'finish': onFinish(); break;
    case 'recover-finish': recoverDraft(btn.dataset.sid, true); break;
    case 'recover-discard': recoverDraft(btn.dataset.sid, false); break;
    case 'dismiss-summary': lsRemove(LS.summary); render(); break;
    case 'toggle-ex': {                         // fold / unfold one exercise's set rows
      if (!current) break;
      const name = btn.dataset.exercise;
      const box = btn.closest('.exercise');
      if (!box) break;
      const folded = !box.classList.contains('is-collapsed');
      box.classList.toggle('is-collapsed', folded);
      btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
      btn.setAttribute('aria-label', (folded ? 'Show' : 'Hide') + ' the sets for ' + name);
      if (!current.draft.collapsed) current.draft.collapsed = {};
      if (folded) current.draft.collapsed[name] = true; else delete current.draft.collapsed[name];
      saveDraft(current.draft);
      break;
    }
    case 'week-minus': setWeek(state.week - 1); render(); break;
    case 'week-plus': setWeek(state.week + 1); render(); break;
    case 'accept-week':
      setWeek(Number(btn.dataset.week));
      lsSet(LS.dismissedSuggest, btn.dataset.sid);
      render();
      break;
    case 'dismiss-week':
      lsSet(LS.dismissedSuggest, btn.dataset.sid);
      render();
      break;
    case 'retry-sync':
      showToast('Syncing…');
      await flushQueue();
      showToast(state.queueCount ? 'Still ' + state.queueCount + ' waiting — will try again later' : 'All synced ✓');
      render();
      break;
    case 'reload-program':
      showToast('Reloading…');
      if (await refreshBootstrap()) { showToast('Program reloaded ✓'); render(); }
      else showToast('Couldn\'t reach the sheet right now');
      break;
    case 'ping': pingAndShow(state.route); break;
    case 'timer-start':
      if (!current) break;
      current.draft.timerStartedAt = localIso(new Date());
      current.draft.timerPausedAt = null;
      current.draft.timerPausedMs = 0;
      current.draft.timerEnded = false;
      current.draft.timerStoppedAt = null;
      markStarted(current.draft);
      scheduleDraftSave();
      refreshTimerCard();
      break;
    case 'timer-pause':                         // Pause: freeze the clock
    case 'timer-stop':                          // End: the same pause, shown as final, with "Start again"
      if (!current || !current.draft.timerStartedAt || current.draft.timerStoppedAt) break;
      timerPause(current.draft, new Date(), action === 'timer-stop');
      scheduleDraftSave();
      refreshTimerCard();
      break;
    case 'timer-resume':                        // Resume / Start again
      if (!current || !current.draft.timerStartedAt) break;
      timerUnpause(current.draft, new Date());
      scheduleDraftSave();
      refreshTimerCard();
      break;
    case 'timer-reset':
      if (!current || !window.confirm('Reset the timer to 00:00?')) break;
      current.draft.timerStartedAt = null;
      current.draft.timerPausedAt = null;
      current.draft.timerPausedMs = 0;
      current.draft.timerEnded = false;
      current.draft.timerStoppedAt = null;
      current.draft.durationMin = null;
      scheduleDraftSave();
      refreshTimerCard();
      break;
    case 'add-cardio': {                        // one more cardio line under the warm-up
      if (!current) break;
      addExtraCardio(current.draft, btn.dataset.slot);
      markStarted(current.draft);
      saveDraft(current.draft);
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
      break;
    }
    case 'remove-cardio': {
      if (!current) break;
      const correction = removeExtraCardio(current.draft, btn.dataset.slot);
      saveDraft(current.draft);
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
      if (correction) scheduleAutosave();         // it was already in the Log: send the "not done" row
      break;
    }
    case 'set-timer': openSetTimer(btn.dataset.kind, btn); break;
    case 'set-timer-end': closeSetTimer(true); break;
    case 'set-timer-cancel': closeSetTimer(false); break;
    case 'swap': openSwapSheet(btn.dataset.slot); break;
    case 'pick-swap': applySwap(btn.dataset.slot, btn.dataset.exercise); break;
    case 'unswap': applySwap(btn.dataset.slot, null); break;
    case 'close-sheet': closeSheet(); break;
    case 'fav': {
      const name = btn.dataset.exercise;
      const on = toggleFavorite(name);
      document.querySelectorAll('.ex-fav').forEach(b => {        // every star for this exercise on the page
        if (libKey(b.dataset.exercise) !== libKey(name)) return;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.textContent = on ? '★ favorite' : '☆ favorite';
      });
      showToast(on ? '★ Added to favorites' : 'Removed from favorites');
      flushQueue().then(rerenderIfPassive);
      break;
    }
    default: break;
  }
}

function bindViewEvents() {
  const view = document.getElementById('view');

  view.addEventListener('input', e => {
    const el = e.target;
    if (!current) return;
    if (el instanceof HTMLTextAreaElement && el.id === 'day-note') {   // the Notes box
      current.draft.note = el.value;
      markStarted(current.draft);
      scheduleDraftSave();
      return;
    }
    if (el instanceof HTMLInputElement && el.dataset.cardioField) {   // minutes / miles / kcal on a cardio line
      const c = current.draft.cardio && current.draft.cardio[el.dataset.slot];
      if (!c) return;
      c[el.dataset.cardioField] = parseWeight(el.value);
      c.touched = true;
      const line = el.closest('.cardio-line');
      if (line) line.querySelectorAll('.in-cardio').forEach(i => i.classList.remove('in-hint'));
      markStarted(current.draft);
      scheduleDraftSave();
      return;
    }
    if (!(el instanceof HTMLInputElement) || !el.dataset.key) return;
    const s = current.draft.sets[el.dataset.key];
    if (!s) return;
    if (el.dataset.field === 'weight') s.weight = parseWeight(el.value);
    else s.reps = parseReps(el.value);
    s.touched = true;
    el.classList.remove('in-hint');                         // her number now, not a suggestion
    markStarted(current.draft);
    scheduleDraftSave();
  });

  view.addEventListener('change', e => {                    // the cardio machine dropdown
    const el = e.target;
    if (!current || !(el instanceof HTMLSelectElement) || !el.dataset.cardioMachine) return;
    const slot = el.dataset.cardioMachine;
    const c = current.draft.cardio && current.draft.cardio[slot];
    if (!c) return;
    c.machine = el.value;
    const remembered = lsGet(LS.cardioLast, {});
    remembered[slot] = c.machine;
    lsSet(LS.cardioLast, remembered);
    if (!c.touched) applyCardioPrefill(c, current.draft.date);   // not her numbers yet: pre-fill for the new machine
    markStarted(current.draft);
    saveDraft(current.draft);
    scheduleAutosave();
    const y = window.scrollY;                                    // redraw: "last time" and history follow the machine
    render();
    window.scrollTo(0, y);
  });

  view.addEventListener('focusin', e => {                   // tapping a field selects it: typing replaces, no backspacing
    const el = e.target;
    if (el instanceof HTMLInputElement && el.classList.contains('in')) setTimeout(() => el.select(), 0);
  });

  view.addEventListener('keydown', e => {                   // Return → next field, like a form
    if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
    e.preventDefault();
    const inputs = [...view.querySelectorAll('input.in')];
    const i = inputs.indexOf(e.target);
    if (i >= 0 && inputs[i + 1]) inputs[i + 1].focus(); else e.target.blur();
  });

  const onClick = e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.classList.contains('done') && current) {
      if (btn.dataset.key) {
        const s = current.draft.sets[btn.dataset.key];
        if (!s) return;
        s.done = !s.done;
        btn.setAttribute('aria-pressed', s.done ? 'true' : 'false');
        const row = btn.closest('.set-row');
        if (row) {
          row.classList.toggle('is-done', s.done);
          row.querySelectorAll('.in').forEach(i => i.classList.toggle('in-hint', !s.done && !s.touched));
        }
        refreshExerciseBadge(s.exercise);
        refreshSaveStatus();                                // "6 of 14 sets done" / "That's everything"
      } else if (btn.dataset.cardioDone) {                   // the ✓ on a cardio line
        const c = current.draft.cardio && current.draft.cardio[btn.dataset.cardioDone];
        if (!c) return;
        c.done = !c.done;
        current.draft.checks[btn.dataset.cardioDone] = c.done;
        btn.setAttribute('aria-pressed', c.done ? 'true' : 'false');
        const line = btn.closest('.cardio-line');
        if (line) {
          line.classList.toggle('is-done', c.done);
          line.querySelectorAll('.in-cardio').forEach(i => i.classList.toggle('in-hint', !c.done && !c.touched));
        }
        refreshSaveStatus();
      } else if (btn.dataset.check) {
        const on = !current.draft.checks[btn.dataset.check];
        current.draft.checks[btn.dataset.check] = on;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        const line = btn.closest('.check-line');
        if (line) line.classList.toggle('is-done', on);
      }
      markStarted(current.draft);
      scheduleDraftSave();
      return;
    }
    if (btn.dataset.action) { e.preventDefault(); handleAction(btn.dataset.action, btn); }
  };
  view.addEventListener('click', onClick);
  document.getElementById('sheet').addEventListener('click', onClick);   // the swap picker lives outside #view
  document.getElementById('timer-modal').addEventListener('click', onClick);   // so does the ⏱ clock
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (location.protocol !== 'https:' && !local) return;
  navigator.serviceWorker.register('./sw.js').catch(e => console.warn('service worker not registered', e));
}

async function boot() {
  registerServiceWorker();
  await loadProgramJson();
  const cached = lsGet(LS.bootstrap, null);
  if (cached) applyBootstrap(cached, 'cache');
  if (!state.program.length && state.programJson) {
    state.program = flattenProgramJson(state.programJson);
    state.programSource = 'fallback';
  }
  replayQueueIntoState();
  initWeek();
  shelveOldDrafts();                          // yesterday's unfinished workout → the "Finish it?" banner on Home
  state.queueCount = readQueue().length;
  bindViewEvents();
  render();

  window.addEventListener('hashchange', e => {
    try { state.prevHash = new URL(e.oldURL).hash; } catch (err) { state.prevHash = ''; }
    render();
  });
  window.addEventListener('online', () => { flushQueue().then(rerenderIfPassive); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {           // phone locked or app switched: send now
      if (current && autosaveTimer) autosaveNow();
      return;
    }
    flushQueue().then(rerenderIfPassive);
    if (current && current.draft.setTimer) { requestWakeLock(); startSetTick(); }   // back to a running ⏱
    if (isStale()) refreshBootstrap().then(ok => { if (ok) rerenderIfPassive(); });
  });
  window.addEventListener('pagehide', () => { if (current && autosaveTimer) autosaveNow(); });

  if (!state.program.length) {
    document.getElementById('view').innerHTML =
      '<p class="empty">Couldn\'t load the program. Check the connection and reopen the app.</p>';
  }
  const ok = await refreshBootstrap();
  if (ok) {
    if (lsGet(LS.week, null) === null) initWeek();
    if (state.route.name !== 'workout' || !current) render(); else renderTopbar(state.route);
  }
  flushQueue().then(rerenderIfPassive);
}

boot();
