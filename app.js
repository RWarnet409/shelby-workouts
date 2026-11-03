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

// ------------------------------------------------------------------------------- 1. config
const APP_VERSION = '5';                       // keep in step with ?v= in index.html and VERSION in sw.js
const DAY_ORDER = ['day1', 'day2', 'day3', 'day4'];
const REQUEST_TIMEOUT_MS = 20000;              // Apps Script usually answers in 1–3 s
const STALE_AFTER_MS = 10 * 60 * 1000;         // re-fetch bootstrap when the app is reopened after this long
const LS = {
  bootstrap: 'swa.bootstrap',                  // { program, last, sessions, fetchedAt } — last good API answer
  programJson: 'swa.programJson',              // copy of program.json (phase banners, week notes, cool-downs)
  week: 'swa.week',                            // the week shown on Home, once it has been set by hand
  queue: 'swa.queue',                          // unsent POSTs: [{ id, action, sets | session, createdAt }]
  dismissedSuggest: 'swa.dismissedSuggest',    // client_id of the session whose "next week?" banner was dismissed
  draftPrefix: 'swa.draft.',                   // + day_id → the workout in progress for that day
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
  const rows = state.program.filter(r => Number(r.phase) === phase && r.day_id === dayId);
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

function unitLabel(unit) {
  return unit === 'time' ? 'sec' : unit === 'minutes' ? 'min' : 'reps';
}

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
        if (b.sets === null || Number(b.sets) <= 0) return row;        // warm-up / finisher lines don't swap
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

// Progression nudge (SPEC §5.2): last time every done set reached the top of the range → suggest more.
function nudgeFor(row) {
  if (!row.log_weight) return null;
  const le = state.last[row.exercise];
  if (!le || !Array.isArray(le.sets) || !le.sets.length) return null;
  const t = parseTarget(row.target);
  if (t.max === null || t.min === t.max) return null;          // no range to be at the top of
  const done = le.sets.filter(s => s.done);
  if (!done.length) return null;
  const allTop = done.every(s => Number(s.reps) >= t.max);
  if (!allTop) return null;
  if (isMachine(row.exercise)) return 'All sets hit ' + t.max + '+ last time — go up one pin';
  if (le.weight === null || le.weight === undefined) return 'All sets hit ' + t.max + '+ last time — try a little more weight';
  return 'All sets hit ' + t.max + '+ last time — try ' + fmtNum(Number(le.weight) + 2.5) + ' lb';
}

// "15 lb × 12, 12, 11" or "15×12, 17.5×10" (weights differ) or "12, 12 reps" (bodyweight)
function setsSummary(sets, row) {
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

function lastTimeText(row) {
  const le = state.last[row.exercise];
  if (!le) return '';
  const sets = (le.sets || []).slice().sort((a, b) => a.set_number - b.set_number);
  if (sets.length) return setsSummary(sets, row) + (le.date ? ' · ' + fmtDate(le.date) : '');
  if (le.weight !== null && le.weight !== undefined) return fmtNum(le.weight) + ' lb';
  return '';
}

// Default values for a set before Shelby touches it: last time's numbers, else the target's low end.
function prefill(row, setNo) {
  const le = state.last[row.exercise];
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
  if (b.last && typeof b.last === 'object') state.last = b.last;
  if (Array.isArray(b.sessions)) state.sessions = b.sessions;
  if (Array.isArray(b.exercises)) state.exercises = b.exercises;   // absent from the old script → keep what we have
  if (Array.isArray(b.favorites)) state.favorites = b.favorites;
  if (b.fetchedAt) state.programUpdatedAt = b.fetchedAt;
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
    if (s.weight !== null && s.weight !== undefined) e.weight = s.weight;
    if (e.date !== s.date) { e.date = s.date; e.sets = []; }
    if (s.reps !== null && s.reps !== undefined && s.reps !== '') e.reps = s.reps;
    const rec = { set_number: s.set_number, weight: s.weight, reps: s.reps, done: !!s.done };
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
  return state.sessions.find(s => isTrue(s.completed)) || null;
}

function nextUpDayId() {
  const s = lastCompletedSession();
  if (!s) return 'day1';
  const i = DAY_ORDER.indexOf(s.day_id);
  return i < 0 ? 'day1' : DAY_ORDER[(i + 1) % DAY_ORDER.length];
}

function doneThisWeek(dayId) {
  const s = state.sessions.find(x => x.day_id === dayId && Number(x.week) === state.week && isTrue(x.completed));
  return s ? s.date : null;
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
  if (d && d.date === today && d.phase === phase) {
    if (!d.swaps) d.swaps = {};               // drafts from before swaps existed
    return d;
  }
  return {
    dayId, date: today, phase,
    createdAt: new Date().toISOString(),
    startedAt: null,                          // first tap/typing; used for duration_min
    sets: {},                                 // "exercise|n" → { weight, reps, done, touched, sentSig }
    checks: {},                               // warmup / finisher lines → true when ticked
    checksSent: {},
    swaps: {},                                // Program exercise → the library exercise done instead, today only
    note: '',                                 // the Notes box at the bottom of the page
    completed: false,                         // true once Save & finish has been tapped
    durationMin: null,                        // minutes from the first tap to Save & finish
    sessionClientId: uuid(),
    sentSessionSig: null,                     // "completed|note" as last queued; a change re-sends the row
  };
}
function saveDraft(d) { lsSet(draftKey(d.dayId), d); }

let draftSaveTimer = null;
function scheduleDraftSave() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => { if (current) saveDraft(current.draft); }, 250);
}

function getSetEntry(draft, row, n) {
  const k = setKey(row.exercise, n);
  if (!draft.sets[k]) {
    const p = prefill(row, n);
    draft.sets[k] = { exercise: row.exercise, set_number: n, weight: p.weight, reps: p.reps, done: false, touched: false, sentSig: null };
  }
  return draft.sets[k];
}

function markStarted(draft) {
  if (!draft.startedAt) draft.startedAt = new Date().toISOString();
}

// Rows to send: sets that are done or were edited, and only when they changed since the last save.
function collectSetsToSend(draft, workout) {
  const out = [];
  const base = { date: draft.date, week: state.week, phase: draft.phase, day_id: draft.dayId, note: '' };
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
      } else if (draft.checks[row.exercise] && !draft.checksSent[row.exercise]) {
        draft.checksSent[row.exercise] = true;
        out.push({ ...base, client_id: uuid(), exercise: row.exercise, set_number: 1, weight: null, reps: null, done: true });
      }
    });
  });
  return out;
}

function durationMinutes(draft) {
  if (!draft.startedAt) return null;
  const mins = Math.round((Date.now() - new Date(draft.startedAt).getTime()) / 60000);
  return mins >= 5 && mins <= 180 ? mins : null;
}

// Queue the set rows and the session row, and update "last time" on this phone right away.
// The session row (completed flag, note, duration) goes out whenever it changed. The script updates
// the existing row for the same client_id, so a note added after finishing still lands.
function saveWorkout(draft, workout, finish) {
  const sets = collectSetsToSend(draft, workout);
  if (sets.length) {
    enqueue({ action: 'logSets', sets });
    applySetsToLast(sets);
  }
  if (finish && !draft.completed) {
    draft.completed = true;
    draft.durationMin = durationMinutes(draft);
    lsRemove(LS.dismissedSuggest);
  }
  const note = String(draft.note || '').trim();
  const hasActivity = sets.length > 0 || note !== '' || draft.completed ||
    Object.values(draft.sets).some(s => s.sentSig) || Object.keys(draft.checksSent || {}).length > 0;
  const sessionSig = (draft.completed ? 1 : 0) + '|' + note;
  let sessionQueued = false;
  if (hasActivity && sessionSig !== (draft.sentSessionSig || null)) {
    const session = {
      client_id: draft.sessionClientId, date: draft.date, week: state.week, phase: draft.phase,
      day_id: draft.dayId, completed: !!draft.completed, duration_min: draft.durationMin || null, note,
    };
    enqueueSession(session);
    draft.sentSessionSig = sessionSig;
    state.sessions = [{ ...session, timestamp: new Date().toISOString() }]
      .concat(state.sessions.filter(s => s.client_id !== session.client_id));
    sessionQueued = true;
  }
  draft.week = state.week;
  draft.lastSavedAt = new Date().toISOString();
  saveDraft(draft);
  persistBootstrapCache();
  return { setsQueued: sets.length, sessionQueued };
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
function parseIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
function fmtDate(iso) {
  const d = parseIsoDate(iso);
  return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : String(iso || '');
}
function fmtDateLong(iso) {
  const d = parseIsoDate(iso);
  return d ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : String(iso || '');
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

  const dayButton = (dayId, big) => {
    const m = dayMeta(dayId);
    const done = doneThisWeek(dayId);
    const optional = dayId === 'day4' ? '<span class="tag">optional in a busy week</span>' : '';
    if (big) {
      return '<a class="next-up" href="#workout/' + dayId + '">' +
        '<span class="eyebrow">Next up</span>' +
        '<span class="big">' + esc(m.day_label) + ' · ' + esc(m.focus) + '</span>' +
        '<span class="meta">~' + esc(m.minutes || '?') + ' min · ' + esc(m.weekday) + '</span>' + optional +
        '</a>';
    }
    return '<a class="day-btn" href="#workout/' + dayId + '">' +
      '<span><strong>' + esc(m.day_label) + '</strong> · ' + esc(m.focus) + optional + '</span>' +
      '<span class="day-meta">' + (done ? '✓ ' + esc(fmtDate(done)) : '~' + esc(m.minutes || '?') + ' min') + '</span>' +
      '</a>';
  };

  let html = '<section class="home">' +
    '<div class="week-row"><div class="week-label">' + esc(weekLabel()) + '</div>' +
    '<div class="stepper"><button type="button" data-action="week-minus" aria-label="Previous week">−</button>' +
    '<button type="button" data-action="week-plus" aria-label="Next week">+</button></div></div>';
  const wn = weekNote(state.week);
  if (wn) html += '<p class="week-note">' + esc(wn) + '</p>';
  if (sug) html += suggestBanner(sug);
  html += dayButton(next, true);
  html += '<p class="muted small" style="margin:14px 0 4px">Or pick another day — slide, don\'t skip:</p>';
  DAY_ORDER.filter(d => d !== next).forEach(d => { html += dayButton(d, false); });
  html += '<p class="rest-note">' + esc(rest) + ': rest — ' + esc(restNote) + '</p>';

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
    '<p class="day-sub">' + esc(weekLabel()) + ' · ' + esc(fmtDateLong(draft.date)) +
    (m.minutes ? ' · ~' + esc(m.minutes) + ' min' : '') + '</p>';
  if (sug) html += suggestBanner(sug);
  if (pi && pi.banner) {
    const head = pi.banner.split(' — ')[0];
    html += '<details class="banner"><summary>' + esc(head) + '</summary><p>' + esc(pi.banner) + '</p></details>';
  }
  const wn = weekNote(state.week);
  if (wn) html += '<p class="week-note">' + esc(wn) + '</p>';
  if (!workout.blocks.length) {
    html += '<p class="empty">No exercises found for ' + esc(m.day_label) + ' in Phase ' + phase + '. Check the Program tab.</p>';
  }
  workout.blocks.forEach(b => { html += blockCard(b, draft); });
  if (workout.cooldown) html += '<p class="cooldown">' + esc(workout.cooldown) + '</p>';
  html += '<section class="card notes-card"><h3>Notes</h3>' +
    '<textarea id="day-note" class="notes" rows="3" placeholder="How did it go? Anything to remember next time?"' +
    ' aria-label="Notes for this workout">' + esc(draft.note || '') + '</textarea></section>';
  html += '</section>' +
    '<div class="savebar"><div class="savebar-inner">' +
    '<div id="save-status" class="save-status">' + esc(initialSaveStatus(draft)) + '</div>' +
    '<div class="savebar-buttons">' +
    '<button type="button" class="btn primary" data-action="save">Save workout</button>' +
    '<button type="button" class="btn secondary" data-action="finish">Save &amp; finish</button>' +
    '</div></div></div>';
  saveDraft(draft);                            // persist the entries prefill just created
  return html;
}

function initialSaveStatus(draft) {
  if (state.queueCount) return state.queueCount + ' save' + (state.queueCount === 1 ? '' : 's') + ' waiting to sync';
  if (draft.lastSavedAt) return 'Saved ✓ ' + fmtTime(draft.lastSavedAt);
  return '';
}

function blockCard(b, draft) {
  const n = b.sets === null ? 0 : Number(b.sets);
  const hint = b.block_type === 'superset' ? 'A then B, rest 45–60 sec'
    : b.block_type === 'circuit' ? 'All four back to back, rest 60–90 sec'
    : b.block_type === 'abs' ? 'Back to back, rest 60 sec between rounds'
    : '';
  let html = '<section class="card block block-' + esc(b.block_type) + '"><h3>' + esc(b.block) + '</h3>' +
    (hint ? '<p class="hint">' + esc(hint) + '</p>' : '');
  b.exercises.forEach(row => { html += n > 0 ? exerciseSets(row, n, draft) : checkLine(row, draft); });
  return html + '</section>';
}

function targetText(row) {
  const t = String(row.target || '');
  return (row.unit === 'reps' || !row.unit) && /^[\d–—-]+$/.test(t) ? t + ' reps' : t;
}

function exerciseSets(row, n, draft) {
  const unit = unitLabel(row.unit);
  const last = lastTimeText(row);
  const nudge = nudgeFor(row);
  // Name with "▶ how to" right after it; "history" on its own line under the name; the rep target
  // sits over the reps column in a header row that uses the same grid as the set rows.
  const slot = row.swapped_from || row.exercise;             // the Program exercise this row stands for
  let sub = '<a class="ex-history" href="#exercise/' + encodeURIComponent(row.exercise) + '">history</a>';
  if (hasLibrary()) {
    const opts = swapOptions(slot, current && current.workout);
    if (opts.same.length || opts.more.length || row.swapped_from) {
      sub += '<button type="button" class="ex-link" data-action="swap" data-slot="' + esc(slot) + '">swap</button>';
    }
    sub += favButton(row.exercise);
  }
  let html = '<div class="exercise">' +
    '<div class="ex-head"><span class="ex-name">' + esc(row.exercise) + '</span>' + videoLink(row.exercise) + '</div>' +
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
  for (let i = 1; i <= n; i++) {
    const s = getSetEntry(draft, row, i);
    const key = setKey(row.exercise, i);
    const label = esc(row.exercise) + ' set ' + i;
    html += '<div class="set-row' + (s.done ? ' is-done' : '') + '" data-row="' + esc(key) + '">' +
      '<span class="set-label">Set ' + i + '</span>';
    if (row.log_weight) {
      html += '<input class="in in-weight" type="text" inputmode="decimal" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="next" placeholder=""' +
        ' value="' + esc(fmtNum(s.weight)) + '" data-key="' + esc(key) + '" data-field="weight" aria-label="' + label + ' weight">' +
        '<span class="unit">lb</span>';
    } else {
      html += '<span class="in in-bw" title="bodyweight">BW</span><span class="unit"></span>';
    }
    html += '<input class="in in-reps" type="text" inputmode="numeric" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="next" placeholder=""' +
      ' value="' + esc(s.reps === null || s.reps === undefined ? '' : s.reps) + '" data-key="' + esc(key) + '" data-field="reps" aria-label="' + label + ' ' + esc(unit) + '">' +
      '<span class="unit">' + esc(unit) + '</span>' +
      '<button type="button" class="done" data-key="' + esc(key) + '" aria-pressed="' + (s.done ? 'true' : 'false') + '" aria-label="' + label + ' done">✓</button>' +
      '</div>';
  }
  return html + '</div>';
}

function checkLine(row, draft) {
  const on = !!draft.checks[row.exercise];
  return '<div class="exercise check-line' + (on ? ' is-done' : '') + '">' +
    '<button type="button" class="done" data-check="' + esc(row.exercise) + '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + esc(row.exercise) + ' done">✓</button>' +
    '<span class="check-text"><span class="ex-head"><span class="ex-name">' + esc(row.exercise) + '</span>' + videoLink(row.exercise) + '</span>' +
    '<span class="ex-target">' + esc(row.target) + '</span>' +
    (row.note ? '<span class="ex-note">' + esc(row.note) + '</span>' : '') + '</span></div>';
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
  saveDraft(draft);
  closeSheet();
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
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
    return '<a class="row" href="#session/' + encodeURIComponent(s.client_id) + '">' +
      '<span><strong>' + esc(m.day_label) + '</strong> · ' + esc(m.focus) + '<br>' +
      '<span class="muted small">' + esc(fmtDateLong(s.date)) + ' · Week ' + esc(s.week) + ' · ' + status + local + '</span>' + noteLine + '</span>' +
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
    '<p class="day-sub">' + esc(fmtDateLong(s.date)) + ' · Week ' + esc(s.week) + ' · ' +
    (isTrue(s.completed) ? 'Completed' : 'Not finished') +
    (s.duration_min ? ' · ' + esc(s.duration_min) + ' min' : '') + '</p>' +
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
    return '<div class="card"><h3>' + esc(n) +
      (swappedFrom ? ' <span class="muted small">in place of ' + esc(swappedFrom) + '</span>' : '') + '</h3>' + sets.map(s =>
      '<div class="set-line"><span>Set ' + esc(s.set_number) + '</span><span>' + esc(setText(s, row, unit)) + '</span>' +
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
    return '<div class="set-line"><span>' + esc(fmtDateLong(d)) + '<br><span class="muted small">Week ' + esc(sets[0].week || '?') + '</span></span>' +
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
    : 'Program from the sheet' + (state.programUpdatedAt ? ', last refreshed ' + fmtDateLong(state.programUpdatedAt) + ' ' + fmtTime(state.programUpdatedAt) : '') + '.';
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
    case 'workout': return { name: 'workout', dayId: DAY_ORDER.includes(arg) ? arg : 'day1' };
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
  const settingsLink = '<a class="topbar-btn" href="#settings" aria-label="Settings">⚙︎</a>';
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
      left.innerHTML = ''; title.textContent = 'Shelby\'s Workouts'; right.innerHTML = historyLink + settingsLink;
  }
}

function render() {
  closeSheet();
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

async function onSave(finish) {
  if (!current) return;
  const { draft, workout } = current;
  if (finish) {
    const anyDone = Object.values(draft.sets).some(s => s.done) || Object.values(draft.checks).some(Boolean);
    if (!anyDone && !window.confirm('No sets are marked done yet. Finish this workout anyway?')) return;
  }
  const result = saveWorkout(draft, workout, finish);
  if (finish) {
    showToast(result.setsQueued || result.sessionQueued ? 'Saved — nice work!' : 'Already saved');
    location.hash = '#';                                   // Home shows the new next-up right away
    flushQueue().then(rerenderIfPassive);
    return;
  }
  if (!result.setsQueued && !result.sessionQueued) {
    setSaveStatus(state.queueCount ? initialSaveStatus(draft) : 'Nothing new to save');
    return;
  }
  setSaveStatus('Saving…');
  await flushQueue();
  if (!current || current.draft !== draft) return;         // moved to another view meanwhile
  if (!state.queueCount) setSaveStatus('Saved to the sheet ✓ ' + fmtTime(new Date().toISOString()));
  else if (!apiConfigured()) setSaveStatus('Saved on this phone (sheet not connected yet)');
  else setSaveStatus('Saved on this phone — will sync when online');
}

async function handleAction(action, btn) {
  switch (action) {
    case 'save': onSave(false); break;
    case 'finish': onSave(true); break;
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
    if (!(el instanceof HTMLInputElement) || !el.dataset.key) return;
    const s = current.draft.sets[el.dataset.key];
    if (!s) return;
    if (el.dataset.field === 'weight') s.weight = parseWeight(el.value);
    else s.reps = parseReps(el.value);
    s.touched = true;
    markStarted(current.draft);
    scheduleDraftSave();
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
        if (row) row.classList.toggle('is-done', s.done);
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
  state.queueCount = readQueue().length;
  bindViewEvents();
  render();

  window.addEventListener('hashchange', e => {
    try { state.prevHash = new URL(e.oldURL).hash; } catch (err) { state.prevHash = ''; }
    render();
  });
  window.addEventListener('online', () => { flushQueue().then(rerenderIfPassive); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    flushQueue().then(rerenderIfPassive);
    if (isStale()) refreshBootstrap().then(ok => { if (ok) rerenderIfPassive(); });
  });

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
