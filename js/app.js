/**
 * Penalty Box — UI layer.
 * All rules live in engine.js; this file stores raw entries, asks the engine
 * for a fresh schedule after every change, and renders it.
 */
import {
  KINDS, parseClock, fmtClock, toElapsed, toClock, fmtPosition, periodLabel,
  periodLengths, computeSchedule, snapshot,
} from './engine.js';
import {
  PRESETS, DEFAULT_COLORS, WHITE, isHex, colorVars, inkFor, similarColors, processLogo, safeLogo,
  loadMyTeams, saveMyTeams, upsertTeam, removeTeam, loadClubTeams, mergeTeams, teamsJson,
} from './teams.js';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */
const STORAGE_KEY = 'penaltybox.v1';
const DURATIONS = [90, 120, 240, 300, 480, 600];
const OT_CHOICES = [0, 180, 240, 300];
const MINOR_CHOICES = [90, 120];
const INFRACTIONS = [
  'Boarding', 'Body checking', 'Butt-ending', 'Charging', 'Checking from behind',
  'Cross-checking', 'Delay of game', 'Elbowing', 'Fighting', 'Head contact',
  'High-sticking', 'Holding', 'Holding the stick', 'Hooking', 'Interference',
  'Kneeing', 'Roughing', 'Slashing', 'Spearing', 'Too many players',
  'Tripping', 'Unsportsmanlike conduct', 'Abuse of officials', 'Other',
];

const DEFAULT_STATE = () => ({
  v: 1,
  config: {
    periods: [900, 900, 900], otLength: 0, minorLen: 120, home: 'Home', away: 'Away', wake: false,
    colors: { ...DEFAULT_COLORS },
    logos: { home: null, away: null },
  },
  penalties: [],
  goals: [],
  check: { period: null, clock: null },
  lastPeriod: 1,
  seq: 0,
});

/* ------------------------------------------------------------------ */
/* Storage (best effort: private windows and sandboxes may refuse)     */
/* ------------------------------------------------------------------ */
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s && s.v === 1 && s.config && Array.isArray(s.penalties)) {
      const d = DEFAULT_STATE();
      const config = { ...d.config, ...s.config };
      // Games saved before team colors/logos existed get the defaults.
      config.colors = {
        home: isHex(s.config.colors?.home) ? s.config.colors.home : d.config.colors.home,
        away: isHex(s.config.colors?.away) ? s.config.colors.away : d.config.colors.away,
      };
      config.logos = { home: safeLogo(s.config.logos?.home), away: safeLogo(s.config.logos?.away) };
      return { ...d, ...s, config };
    }
  } catch { /* ignore */ }
  return null;
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

let state = load() ?? sampleState();
let schedule = null;
let showDone = { home: false, away: false };

// Team list: club teams (teams.json in the repo) + teams saved on this phone.
let clubTeams = [];
let myTeams = loadMyTeams();
const allTeams = () => mergeTeams(clubTeams, myTeams);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const teamName = (t) => (t === 'home' ? state.config.home : state.config.away) || (t === 'home' ? 'Home' : 'Away');
const nextId = (p) => `${p}${++state.seq}`;
const sideLabel = (t) => (t === 'home' ? 'Home' : 'Away');
const teamLogo = (t) => state.config.logos?.[t] || null;

/** Logo on a white chip (logos are drawn for light backgrounds). Empty string when none. */
function logoChip(src, cls = '') {
  return src ? `<span class="logo ${cls}"><img src="${esc(src)}" alt=""></span>` : '';
}

/** Initials for a team with no logo, e.g. "Example Hawks" -> "EH". */
const initials = (name) => String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase() || '?';

/** Push both teams' colors into CSS variables used across the app. */
function applyTeamColors() {
  const root = document.documentElement.style;
  for (const side of ['home', 'away']) {
    for (const [k, v] of Object.entries(colorVars(side, state.config.colors?.[side]))) root.setProperty(k, v);
  }
}
const kindLabel = (k) => KINDS[k]?.label ?? k;

function defaultDuration(kind) {
  const m = state.config.minorLen;
  return { minor: m, double: m * 2, major: 300, misconduct: 600, ejection: 0 }[kind] ?? m;
}

/** Period choices for the current config: [{v:1,label:'P1'}, …, {v:4,label:'OT'}] */
function periodChoices() {
  return periodLengths(state.config).map((_, i) => ({ v: i + 1, label: periodLabel(state.config, i + 1).replace(/^P/, '') }));
}

function who(p) {
  if (p.player && p.servedBy) return `#${esc(p.player)} <span class="pen-note">served by #${esc(p.servedBy)}</span>`;
  if (p.player) return `#${esc(p.player)}`;
  return `Bench <span class="pen-note">served by #${esc(p.servedBy)}</span>`;
}
const whoText = (p) => (p.player ? `#${p.player}` : 'Bench') + (p.servedBy ? ` (served by #${p.servedBy})` : '');

/** Reference "now": the scoreboard clock if entered, else the last logged event. */
function referenceNow() {
  const { period, clock } = state.check;
  if (period && clock != null) return { at: toElapsed(state.config, period, clock), live: true };
  const times = [
    ...state.penalties.map((p) => toElapsed(state.config, p.period, p.clock)),
    ...state.goals.map((g) => toElapsed(state.config, g.period, g.clock)),
  ];
  return { at: times.length ? Math.max(...times) : 0, live: false };
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/** Two-tap confirm for destructive buttons (dialogs are unreliable in some hosts). */
function confirmTap(btn, label, action) {
  if (btn.classList.contains('confirming')) {
    clearTimeout(btn._t);
    btn.classList.remove('confirming');
    btn.textContent = btn._orig;
    action();
    return;
  }
  btn._orig = btn.textContent;
  btn.classList.add('confirming');
  btn.textContent = label;
  btn._t = setTimeout(() => { btn.classList.remove('confirming'); btn.textContent = btn._orig; }, 3000);
}

/** Render a segmented control / chip group. */
function renderChoice(el, options, value, onPick) {
  el.innerHTML = options.map((o) =>
    `<button type="button" role="radio" data-v="${esc(o.v)}" aria-checked="${String(o.v) === String(value)}">${esc(o.label)}</button>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    const raw = b.dataset.v;
    onPick(/^-?\d+$/.test(raw) ? Number(raw) : raw);
  };
}

/** Normalise a clock field on blur ("934" -> "9:34"). */
/**
 * Format clock digits as they are typed, filling from the right
 * (scoreboard-keypad / microwave style): 1 → 0:01, 13 → 0:13, 130 → 1:30, 1305 → 13:05.
 * The last two digits are always seconds, which matches parseClock().
 */
function formatClockDigits(raw) {
  const digits = raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 4);
  if (!digits) return '';
  const padded = digits.padStart(3, '0');           // ensure at least m:ss
  return `${Number(padded.slice(0, -2))}:${padded.slice(-2)}`;
}

function bindClockField(input) {
  // Tapping into a filled field selects it, so typing replaces the old time.
  // Done on the click that follows focus (not a timer) so it can never fire
  // mid-typing; a second tap inside the field still places the caret normally.
  let justFocused = false;
  input.addEventListener('focus', () => { justFocused = true; });
  input.addEventListener('click', () => {
    if (justFocused && input.value) input.setSelectionRange(0, input.value.length);
    justFocused = false;
  });
  input.addEventListener('keydown', () => { justFocused = false; });
  input.addEventListener('input', () => {
    input.value = formatClockDigits(input.value);
    // Keep the caret at the end: digits always enter from the right.
    const end = input.value.length;
    try { input.setSelectionRange(end, end); } catch { /* some input types refuse */ }
  });
  input.addEventListener('blur', () => {
    const s = parseClock(input.value);
    if (s != null) input.value = fmtClock(s);
  });
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */
function recompute() {
  schedule = computeSchedule(state.config, state.penalties, state.goals);
}

function render() {
  recompute();
  const ref = referenceNow();
  applyTeamColors();
  renderActions();
  renderStrength(ref);
  renderCheck(ref);
  renderBoard(ref);
  renderLog();
  renderSetup();
  renderTeamList();
  save();
}

/** Bottom bar: + Penalty buttons in team colors, with logos. */
function renderActions() {
  for (const side of ['home', 'away']) {
    const logo = teamLogo(side);
    const btn = document.querySelector(`.act.${side}`);
    // Big logo on the left; team name above "Penalty" on the right.
    btn.classList.toggle('with-logo', !!logo);
    btn.innerHTML = `${logoChip(logo, 'act-logo')}<span class="act-text"><small><em>${esc(teamName(side))}</em></small><span>Penalty</span></span>`;
    btn.setAttribute('aria-label', `Add ${teamName(side)} penalty`);
  }

  // Goal button doubles as the scoreboard: home score left, away score right,
  // each in its team's jersey color (same order as the Penalty buttons).
  const score = currentScore();
  const goalBtn = document.querySelector('.act.goal');
  goalBtn.innerHTML = `<span class="act-text"><small>Goal</small><span class="score${score.home > 9 || score.away > 9 ? ' wide' : ''}"><b class="h">${score.home}</b><i aria-hidden="true">–</i><b class="a">${score.away}</b></span></span>`;
  goalBtn.setAttribute('aria-label', `Record a goal. Score: ${teamName('home')} ${score.home}, ${teamName('away')} ${score.away}`);
}

/** Goals logged so far, per team. */
function currentScore() {
  const score = { home: 0, away: 0 };
  for (const g of state.goals) if (g.team in score) score[g.team]++;
  return score;
}

function renderStrength(ref) {
  const snap = snapshot(schedule, ref.at);
  // Digits only, colored by team: names don't fit next to the title on a phone.
  $('strength').innerHTML =
    `<b class="h">${snap.strength.home}</b> v <b class="a">${snap.strength.away}</b>`;
  $('strength').setAttribute('aria-label', `${teamName('home')} ${snap.strength.home} skaters, ${teamName('away')} ${snap.strength.away} skaters`);
}

function renderCheck(ref) {
  const sec = document.querySelector('.check');
  sec.classList.toggle('active', ref.live);
  renderChoice($('check-period'), periodChoices(), state.check.period, (v) => {
    state.check.period = v;
    if (state.check.clock == null) $('check-clock').focus();
    render();
  });
  const input = $('check-clock');
  if (document.activeElement !== input) input.value = state.check.clock != null ? fmtClock(state.check.clock) : '';
  $('check-clear').hidden = !ref.live && !state.check.period;
  $('check-hint').textContent = ref.live
    ? `Penalty clocks shown for ${fmtPosition(state.config, ref.at)}.`
    : state.penalties.length
      ? `Showing penalties still running after your last entry (${fmtPosition(state.config, ref.at)}). Enter the game clock to see time left.`
      : 'Enter the game clock to see what each penalty clock should read.';
}

function renderBoard(ref) {
  const snap = snapshot(schedule, ref.at);
  const html = ['home', 'away'].map((team) => {
    const list = schedule.penalties.filter((p) => p.team === team && p.assessedAt <= ref.at);
    // "Active" = not finished at the reference time (running or still delayed).
    const active = list.filter((p) => !p.noClock && p.end > ref.at).sort((a, b) => a.end - b.end);
    const done = list.filter((p) => p.noClock || p.end <= ref.at).sort((a, b) => b.end - a.end);
    // Penalties assessed after the "Scoreboard now" time: not in the box yet at that
    // moment, but listed (never hidden) so a stale scoreboard time is obvious.
    const laterList = ref.live
      ? schedule.penalties.filter((p) => p.team === team && p.assessedAt > ref.at).sort((a, b) => a.assessedAt - b.assessedAt)
      : [];
    const later = laterList.length;

    const emptyMsg = later
      ? `<p class="empty">No one in the box at ${esc(fmtPosition(state.config, ref.at))}.</p>`
      : '<p class="empty">No one in the box.</p>';
    const rows = (active.map((p) => penaltyRow(p, ref, snap)).join('') || emptyMsg) +
      laterList.map((p) => laterRow(p)).join('');
    const doneRows = showDone[team] ? done.map((p) => penaltyRow(p, ref, snap, true)).join('') : '';
    const toggle = done.length
      ? `<button class="done-toggle" type="button" data-done="${team}">${showDone[team] ? 'Hide' : 'Show'} ${done.length} finished</button>`
      : '';
    const sub = `${active.length} in box${later ? ` · ${later} later` : ''}`;
    return `<article class="team ${team}">
      <div class="team-head"><div class="team-title">${logoChip(teamLogo(team), 'head-logo')}<h3>${esc(teamName(team))}</h3></div><span class="sub">${sub}</span></div>
      ${rows}${toggle}${doneRows}
    </article>`;
  }).join('');
  $('board').innerHTML = html;
}

/** A penalty assessed after the "Scoreboard now" time. */
function laterRow(p) {
  const cfg = state.config;
  const what = [kindLabel(p.kind), p.noClock ? null : fmtClock(p.duration), p.infraction].filter(Boolean).map(esc).join(' · ');
  return `<div class="pen later">
    <div class="pen-who"><div class="num">${who(p)}</div><div class="what">${what}</div></div>
    <div class="pen-when"><span class="label">Assessed</span><span class="time">${esc(fmtPosition(cfg, p.assessedAt))}</span></div>
    <div class="pen-meta"><span class="pill wait">After scoreboard time</span><span class="pen-note">Update Scoreboard now to see it in the box</span></div>
  </div>`;
}

function penaltyRow(p, ref, snap, isDone = false) {
  const cfg = state.config;
  const endClock = toClock(cfg, p.end);
  const what = [kindLabel(p.kind), p.noClock ? null : fmtClock(p.duration), p.infraction].filter(Boolean).map(esc).join(' · ');
  const pills = [];
  const notes = [];

  if (p.noClock) {
    pills.push('<span class="pill">Ejected</span>');
  } else if (isDone) {
    pills.push(p.endReason === 'released'
      ? `<span class="pill">Released by PPG</span>`
      : `<span class="pill">Expired</span>`);
  } else if (p.start > ref.at) {
    pills.push(`<span class="pill wait">Delayed</span>`);
    notes.push(`Starts ${fmtPosition(cfg, p.start)}`);
  } else {
    pills.push(`<span class="pill run">Running</span>`);
    if (ref.live) pills.push(`<span class="pill left">${fmtClock(p.end - ref.at)} left</span>`);
  }

  if (!isDone && !p.noClock) {
    if (p.coincidental) notes.push('Coincidental');
    if (p.delayed && p.start <= ref.at) notes.push(`Started ${fmtPosition(cfg, p.start)}`);
    if (p.halfReleasedBy) notes.push('First half ended by PPG');
    if (p.kind === 'misconduct') notes.push('Player returns at first stoppage after expiry');
    // A player whose penalty expires as a delayed penalty starts stays in the box until the stoppage.
    const handoff = schedule.penalties.find((q) => q !== p && q.team === p.team && q.delayed && q.strength &&
      q.start === p.end && q.server !== p.server);
    if (handoff && p.strength) notes.push('Stays in box until next stoppage (delayed penalty starts)');
    if (endClock.beyond) notes.push(cfg.otLength ? 'Runs past end of overtime' : 'Carries past regulation');
    else if (endClock.period > p.period) notes.push(`Carries into ${periodLabel(cfg, endClock.period)}`);
  }

  const label = p.noClock ? 'Logged' : isDone ? (p.endReason === 'released' ? 'Released' : 'Expired') : 'Expires';
  const time = p.noClock ? fmtPosition(cfg, p.assessedAt) : fmtPosition(cfg, p.end);

  return `<div class="pen${isDone ? ' done' : ''}">
    <div class="pen-who"><div class="num">${who(p)}</div><div class="what">${what}</div></div>
    <div class="pen-when"><span class="label">${label}</span><span class="time">${esc(time)}</span></div>
    <div class="pen-meta">${pills.join('')}${notes.map((n) => `<span class="pen-note">${esc(n)}</span>`).join('<span class="pen-note">·</span>')}</div>
  </div>`;
}

function logEntries() {
  const cfg = state.config;
  const items = [
    ...schedule.penalties.map((p) => ({ type: 'penalty', at: p.assessedAt, order: p.order, p })),
    ...schedule.goals.map((g) => ({ type: 'goal', at: g.at, order: 1e6 + g.order, g })),
  ];
  return items.sort((a, b) => a.at - b.at || a.order - b.order).map((it) => {
    if (it.type === 'penalty') {
      const p = it.p;
      const desc = p.noClock
        ? `${kindLabel(p.kind)}`
        : `${kindLabel(p.kind)} ${fmtClock(p.duration)} → ${p.endReason === 'released' ? 'released' : 'ends'} ${fmtPosition(cfg, p.end)}`;
      return { id: p.id, kind: 'penalty', team: p.team, time: fmtPosition(cfg, p.assessedAt), text: `${whoText(p)} ${p.infraction ? `${p.infraction}, ` : ''}${desc}` };
    }
    const g = it.g;
    const rel = g.released ? schedule.penalties.find((p) => p.id === g.released) : null;
    const half = schedule.penalties.find((p) => p.halfReleasedBy === g.id);
    const note = rel ? `PPG, releases ${whoText(rel)}` : half ? `PPG, ends first half of ${whoText(half)} double minor` : '';
    return { id: g.id, kind: 'goal', team: g.team, time: fmtPosition(cfg, g.at), text: `Goal${g.scorer ? ` #${g.scorer}` : ''}${note ? ` (${note})` : ''}` };
  });
}

function renderLog() {
  const entries = logEntries();
  $('log-count').textContent = entries.length ? `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` : '';
  $('log').innerHTML = entries.length
    ? entries.map((e) => `<li>
        <span class="t">${esc(e.time)}</span>
        <span class="d"><b class="${e.team === 'home' ? 'h' : 'a'}">${esc(teamName(e.team))}</b> ${esc(e.text)}</span>
        <button class="x" type="button" data-del="${e.id}" aria-label="Delete entry">Delete</button>
      </li>`).join('')
    : '<li class="empty">Nothing logged yet. Use the buttons below to add a penalty or goal.</li>';
}

/* ------------------------------------------------------------------ */
/* Team cards (Game setup): name, color, logo, saved-team picker       */
/* ------------------------------------------------------------------ */

/** Build the two team cards once. Later renders only update them, so the
 *  native color picker and file picker are never torn down mid-use. */
function buildTeamCards() {
  $('cfg-teams').innerHTML = ['home', 'away'].map((side) => `
    <div class="team-card" data-side="${side}">
      <div class="team-card-head">
        <span class="side-label">${sideLabel(side)}</span>
        <select class="team-pick" id="cfg-${side}-pick" aria-label="Choose a saved ${side} team"></select>
      </div>
      <div class="team-card-id">
        <button type="button" class="logo-btn" id="cfg-${side}-logo"></button>
        <input id="cfg-${side}" type="text" maxlength="24" autocomplete="off" aria-label="${sideLabel(side)} team name">
      </div>
      <div class="swatches" id="cfg-${side}-colors" role="radiogroup" aria-label="${sideLabel(side)} team color">
        ${PRESETS.map((p) => `<button type="button" role="radio" class="swatch" data-color="${p.hex}" style="--sw:${p.hex}" aria-label="${p.name}" title="${p.name}"></button>`).join('')}
        <label class="swatch custom" title="Custom color"><input type="color" id="cfg-${side}-custom" aria-label="Custom ${side} team color"></label>
      </div>
      <div class="row-actions">
        <button type="button" class="btn small" id="cfg-${side}-save">Save to team list</button>
        <button type="button" class="btn-ghost small" id="cfg-${side}-logo-remove">Remove logo</button>
      </div>
      <input type="file" id="cfg-${side}-file" accept="image/*" hidden>
    </div>`).join('');
}

let pickerKey = '';   // rebuild the saved-team <select>s only when the list changes

function renderTeamCards() {
  const cfg = state.config;
  const teams = allTeams();
  const key = JSON.stringify(teams.map((t) => [t.name, t.source]));
  const rebuildPickers = key !== pickerKey;
  pickerKey = key;

  for (const side of ['home', 'away']) {
    const name = $(`cfg-${side}`);
    if (document.activeElement !== name) name.value = cfg[side];

    const logo = teamLogo(side);
    const lb = $(`cfg-${side}-logo`);
    lb.classList.toggle('has', !!logo);
    lb.innerHTML = logo ? `<img src="${esc(logo)}" alt="">` : '<span>Add<br>logo</span>';
    lb.setAttribute('aria-label', logo ? `Replace ${side} team logo` : `Add ${side} team logo`);
    $(`cfg-${side}-logo-remove`).hidden = !logo;

    // Color swatches: mark the current one; custom shows any non-preset color.
    const color = cfg.colors[side];
    const isPreset = PRESETS.some((p) => p.hex === color);
    $(`cfg-${side}-colors`).querySelectorAll('button.swatch').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.color === color));
    });
    const custom = $(`cfg-${side}-custom`);
    custom.value = color;
    const label = custom.closest('.swatch');
    label.classList.toggle('active', !isPreset);
    label.style.setProperty('--sw', color);

    if (rebuildPickers) {
      const club = teams.filter((t) => t.source !== 'mine');
      const mine = teams.filter((t) => t.source === 'mine');
      const opts = (list) => list.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('');
      const pick = $(`cfg-${side}-pick`);
      pick.innerHTML = teams.length
        ? `<option value="">Saved teams…</option>${club.length ? `<optgroup label="Club">${opts(club)}</optgroup>` : ''}${mine.length ? `<optgroup label="My teams">${opts(mine)}</optgroup>` : ''}`
        : '<option value="">No saved teams yet</option>';
      pick.disabled = !teams.length;
    }
  }
  $('cfg-color-warn').hidden = !similarColors(cfg.colors.home, cfg.colors.away);
}

/** Apply a saved team to one side of this game. */
function useTeam(side, name) {
  const t = allTeams().find((x) => x.name === name);
  if (!t) return;
  state.config[side] = t.name;
  if (t.color) state.config.colors[side] = t.color;
  state.config.logos[side] = t.logo || null;
  render();
  toast(`${t.name} set as ${sideLabel(side).toLowerCase()} team`);
}

function saveTeamToList(side) {
  const name = String(state.config[side] || '').trim();
  if (!name || /^(home|away)$/i.test(name)) { toast('Give the team a name first.'); $(`cfg-${side}`).focus(); return; }
  // White is tonight's jersey, not the team's color: keep the saved color if there is one.
  let color = state.config.colors[side];
  const existing = allTeams().find((t) => t.name.toLowerCase() === name.toLowerCase());
  const keptColor = color === WHITE && existing?.color && existing.color !== WHITE;
  if (keptColor) color = existing.color;
  const next = upsertTeam(myTeams, { name, color, logo: teamLogo(side) });
  if (!saveMyTeams(next)) { toast('Phone storage is full. Remove a team or logo and try again.'); return; }
  myTeams = next;
  render();
  toast(keptColor ? `${name} saved (kept its team color; white is just tonight’s jersey)` : `${name} saved to team list`);
}

async function addLogo(side, file) {
  if (!file) return;
  try {
    state.config.logos[side] = await processLogo(file);
    render();
    toast('Logo added');
  } catch {
    toast('Couldn’t read that image. Try a PNG or JPG.');
  }
}

/* ------------------------------------------------------------------ */
/* Team list panel                                                     */
/* ------------------------------------------------------------------ */
function renderTeamList() {
  const teams = allTeams();
  $('teams-count').textContent = teams.length ? `${teams.length} team${teams.length === 1 ? '' : 's'}` : '';
  $('btn-teams-export').disabled = !teams.length;
  $('btn-teams-share').disabled = !teams.length;
  const pill = { club: 'Club', mine: 'This phone', 'club-edited': 'Club · edited here' };
  $('team-list').innerHTML = teams.length
    ? teams.map((t) => `<li style="--tc:${esc(t.color || '#888888')};--tc-ink:${inkFor(t.color || '#888888')}">
        ${t.logo ? logoChip(t.logo, 'tl-logo') : `<span class="tl-logo tl-mono">${esc(initials(t.name))}</span>`}
        <span class="tl-name"><b>${esc(t.name)}</b><span class="tl-meta"><i class="tl-dot" aria-hidden="true"></i>${pill[t.source]}</span></span>
        ${t.source === 'club' ? '' : `<button class="x" type="button" data-team-del="${esc(t.name)}">${t.source === 'club-edited' ? 'Undo edits' : 'Delete'}</button>`}
      </li>`).join('')
    : '<li class="empty">No saved teams yet. Set a team’s name, color and logo in Game setup, then tap “Save to team list”.</li>';
}

/** One line shown on the Game setup heading while it's collapsed. */
function setupSummary() {
  const cfg = state.config;
  const lens = cfg.periods;
  const periods = lens.every((l) => l === lens[0]) ? `${lens.length} × ${fmtClock(lens[0])}` : lens.map(fmtClock).join(' / ');
  return `${teamName('home')} vs ${teamName('away')} · ${periods}${cfg.otLength ? ` + OT ${fmtClock(cfg.otLength)}` : ''}`;
}

function renderSetup() {
  const cfg = state.config;
  $('setup-summary').textContent = setupSummary();
  renderTeamCards();

  const wrap = $('cfg-periods');
  if (!wrap.contains(document.activeElement)) {
    wrap.innerHTML =
      `<div class="seg" id="cfg-count" role="radiogroup" aria-label="Number of periods">${[2, 3].map((n) =>
        `<button type="button" role="radio" data-count="${n}" aria-checked="${cfg.periods.length === n}">${n} periods</button>`).join('')}</div>` +
      cfg.periods.map((len, i) =>
        `<label>P${i + 1}<input type="text" inputmode="numeric" id="cfg-p${i + 1}" data-pi="${i}" value="${fmtClock(len)}" aria-label="Period ${i + 1} length"></label>`).join('');
    wrap.querySelectorAll('input[data-pi]').forEach(bindClockField);
  }
  renderChoice($('cfg-ot'), OT_CHOICES.map((v) => ({ v, label: v ? fmtClock(v) : 'Off' })), cfg.otLength, (v) => {
    const otPeriod = cfg.periods.length + 1;
    if (!v && usesPeriod(otPeriod)) return toast('Delete the overtime entries first.');
    cfg.otLength = v;
    render();
  });
  renderChoice($('cfg-minor'), MINOR_CHOICES.map((v) => ({ v, label: fmtClock(v) })), cfg.minorLen, (v) => {
    cfg.minorLen = v; render();
  });
  $('cfg-wake').checked = !!cfg.wake;
}

const usesPeriod = (n) => [...state.penalties, ...state.goals].some((e) => e.period === n) || state.check.period === n;

/* ------------------------------------------------------------------ */
/* Entry sheet                                                         */
/* ------------------------------------------------------------------ */
const form = { mode: 'penalty', team: null, kind: 'minor', duration: 120, period: 1 };

function openSheet(mode, team) {
  Object.assign(form, {
    mode, team: team ?? null, kind: 'minor', duration: defaultDuration('minor'),
    period: state.check.period ?? state.lastPeriod ?? 1,
  });
  if (form.period > periodChoices().length) form.period = 1;
  const f = $('sheet');
  f.reset();
  $('f-clock').value = '';
  f.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== mode; });
  $('sheet-title').textContent = mode === 'goal' ? 'Goal' : 'Penalty';
  $('f-submit').textContent = mode === 'goal' ? 'Add goal' : 'Add penalty';
  $('f-error').textContent = '';
  $('f-infraction').innerHTML = `<option value="">—</option>${INFRACTIONS.map((i) => `<option>${esc(i)}</option>`).join('')}`;
  renderSheetChoices();
  $('sheet-backdrop').hidden = false;
  f.hidden = false;
  // Put the cursor where the first keystroke belongs.
  setTimeout(() => (mode === 'goal' ? $('f-clock') : $('f-player')).focus(), 50);
  updatePreview();
}

function closeSheet() {
  $('sheet').hidden = true;
  $('sheet-backdrop').hidden = true;
}

function renderSheetChoices() {
  // Team picker shows each team's logo and, when selected, its color.
  const teamSeg = $('f-team');
  teamSeg.innerHTML = ['home', 'away'].map((side) =>
    `<button type="button" role="radio" data-v="${side}" aria-checked="${form.team === side}">${logoChip(teamLogo(side), 'seg-logo')}<span>${esc(teamName(side))}</span></button>`).join('');
  teamSeg.onclick = (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) { form.team = b.dataset.v; renderSheetChoices(); updatePreview(); }
  };
  renderChoice($('f-kind'), Object.entries(KINDS).map(([v, k]) => ({ v, label: k.label })), form.kind, (v) => {
    form.kind = v; form.duration = defaultDuration(v); renderSheetChoices(); updatePreview();
  });
  const dur = $('f-duration').closest('.field');
  dur.hidden = form.mode !== 'penalty' || form.kind === 'ejection';
  renderChoice($('f-duration'), DURATIONS.map((v) => ({ v, label: fmtClock(v) })), form.duration, (v) => {
    form.duration = v; renderSheetChoices(); updatePreview();
  });
  renderChoice($('f-period'), periodChoices().map((p) => ({ v: p.v, label: p.label })), form.period, (v) => {
    form.period = v; renderSheetChoices(); updatePreview();
  });
}

/** Read and validate the sheet. Returns { entry } or { error }. */
function readSheet() {
  if (!form.team) return { error: 'Pick a team.' };
  const clock = parseClock($('f-clock').value);
  const len = periodLengths(state.config)[form.period - 1];
  if (clock == null) return { error: 'Enter the game clock, e.g. 10:34.' };
  if (clock > len) return { error: `${periodLabel(state.config, form.period)} is only ${fmtClock(len)} long.` };
  if (form.mode === 'goal') {
    return { entry: { id: '__draft', team: form.team, period: form.period, clock, scorer: $('f-scorer').value.trim() } };
  }
  const player = $('f-player').value.trim();
  const servedBy = $('f-served').value.trim();
  if (!player && !servedBy) return { error: 'Enter the player number, or who serves a bench penalty.' };
  return {
    entry: {
      id: '__draft', team: form.team, player, servedBy, kind: form.kind,
      duration: form.kind === 'ejection' ? 0 : form.duration,
      infraction: $('f-infraction').value, period: form.period, clock,
      coincidental: $('f-coinc').checked,
    },
  };
}

/** Dry-run the schedule with the draft entry so the result shows before saving. */
function updatePreview() {
  const box = $('f-preview');
  const { entry, error } = readSheet();
  if (!entry) {
    box.innerHTML = `<span class="note">${esc(error === 'Pick a team.' ? 'Pick a team to see the result.' : 'Enter the game clock to see the result.')}</span>`;
    return;
  }
  const cfg = state.config;
  if (form.mode === 'goal') {
    const s = computeSchedule(cfg, state.penalties, [...state.goals, entry]);
    const g = s.goals.find((x) => x.id === '__draft');
    const rel = g.released && s.penalties.find((p) => p.id === g.released);
    const half = s.penalties.find((p) => p.halfReleasedBy === '__draft');
    box.innerHTML = rel
      ? `<span class="label">Power-play goal</span><span class="time">Releases ${esc(whoText(rel))}</span>`
      : half
        ? `<span class="label">Power-play goal</span><span class="time">${esc(whoText(half))}: 2nd half starts</span><span class="note">Double minor now ends ${esc(fmtPosition(cfg, half.end))}</span>`
        : `<span class="label">Goal</span><span class="note">No penalty released.</span>`;
    return;
  }
  const s = computeSchedule(cfg, [...state.penalties, entry], state.goals);
  const p = s.penalties.find((x) => x.id === '__draft');
  if (p.noClock) {
    box.innerHTML = `<span class="label">Logged only</span><span class="note">No penalty clock. Record any major or minor that goes with it as its own entry.</span>`;
    return;
  }
  const end = toClock(cfg, p.end);
  const extra = [];
  if (p.delayed) extra.push(`Delayed: starts ${fmtPosition(cfg, p.start)}`);
  if (end.beyond) extra.push(cfg.otLength ? 'Runs past end of overtime' : 'Carries past regulation');
  else if (end.period > p.period) extra.push(`Carries into ${periodLabel(cfg, end.period)}`);
  if (p.coincidental) extra.push('No change to team strength');
  box.innerHTML = `<span class="label">Expires</span><span class="time">${esc(fmtPosition(cfg, p.end))}</span>` +
    (extra.length ? `<span class="note">${esc(extra.join(' · '))}</span>` : '');
}

function submitSheet(e) {
  e.preventDefault();
  const { entry, error } = readSheet();
  if (!entry) { $('f-error').textContent = error; return; }
  if (form.mode === 'goal') {
    entry.id = nextId('g');
    state.goals.push(entry);
  } else {
    entry.id = nextId('p');
    state.penalties.push(entry);
  }
  state.lastPeriod = entry.period;

  // A new entry means the scoreboard has reached at least that time. If
  // "Scoreboard now" is behind it, move it forward so the entry shows in the box.
  let moved = false;
  const { period: cp, clock: cc } = state.check;
  if (cp && cc != null && toElapsed(state.config, entry.period, entry.clock) > toElapsed(state.config, cp, cc)) {
    state.check = { period: entry.period, clock: entry.clock };
    moved = true;
  }

  closeSheet();
  render();
  const what = form.mode === 'goal' ? 'Goal added' : 'Penalty added';
  toast(moved ? `${what} · Scoreboard now set to ${fmtPosition(state.config, toElapsed(state.config, entry.period, entry.clock))}` : what);
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */
function csv() {
  const cfg = state.config;
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Type', 'Team', 'Player', 'Served by', 'Penalty', 'Infraction', 'Length', 'Assessed', 'Starts', 'Ends', 'Outcome']];
  const items = [
    ...schedule.penalties.map((p) => ({ at: p.assessedAt, o: p.order, p })),
    ...schedule.goals.map((g) => ({ at: g.at, o: 1e6 + g.order, g })),
  ].sort((a, b) => a.at - b.at || a.o - b.o);
  for (const it of items) {
    if (it.p) {
      const p = it.p;
      rows.push(['Penalty', teamName(p.team), p.player, p.servedBy, kindLabel(p.kind), p.infraction,
        p.noClock ? '' : fmtClock(p.duration), fmtPosition(cfg, p.assessedAt),
        p.noClock ? '' : fmtPosition(cfg, p.start), p.noClock ? '' : fmtPosition(cfg, p.end),
        p.noClock ? 'Ejected' : p.endReason === 'released' ? 'Released by PPG' : p.coincidental ? 'Coincidental' : 'Served']);
    } else {
      const g = it.g;
      const rel = g.released && schedule.penalties.find((p) => p.id === g.released);
      const half = schedule.penalties.find((p) => p.halfReleasedBy === g.id);
      rows.push(['Goal', teamName(g.team), g.scorer, '', '', '', '', fmtPosition(cfg, g.at), '', '',
        rel ? `PPG – released ${whoText(rel)}` : half ? `PPG – ended 1st half of ${whoText(half)}` : '']);
    }
  }
  return rows.map((r) => r.map(q).join(',')).join('\r\n');
}

function csvFilename() {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `penalties-${date}-${slug(teamName('home'))}-vs-${slug(teamName('away'))}.csv`;
}

/** Save text as a file via a temporary link. */
function downloadFile(text, filename, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Hand a file to the phone's share sheet (Files, AirDrop, email, Drive…). */
async function shareFile(text, filename, type, title, fallbackLabel) {
  try {
    await navigator.share({ files: [new File([text], filename, { type })], title });
  } catch (err) {
    if (err?.name !== 'AbortError') toast(`Sharing failed. Use ${fallbackLabel} instead.`);
  }
}

const downloadCsv = () => downloadFile(csv(), csvFilename(), 'text/csv');
const shareCsv = () => shareFile(csv(), csvFilename(), 'text/csv', 'Penalty log', 'Download CSV');
const downloadTeams = () => downloadFile(teamsJson(allTeams()), 'teams.json', 'application/json');
const shareTeams = () => shareFile(teamsJson(allTeams()), 'teams.json', 'application/json', 'Team list', 'Download teams.json');

async function copyLog() {
  const text = [`${teamName('home')} vs ${teamName('away')}`,
    ...logEntries().map((e) => `${e.time}  ${teamName(e.team)}  ${e.text}`)].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $('copy-fallback').hidden = true;
    toast('Log copied');
  } catch {
    const ta = $('copy-fallback');
    ta.hidden = false;
    ta.value = text;
    ta.focus();
    ta.select();
    toast('Select all and copy');
  }
}

/* ------------------------------------------------------------------ */
/* Screen wake lock (keeps the phone awake on the bench)               */
/* ------------------------------------------------------------------ */
let wakeLock = null;
async function applyWake() {
  try {
    if (state.config.wake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      if (!wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } else if (wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    if (state.config.wake) toast('This browser can’t keep the screen awake.');
  }
}

/* ------------------------------------------------------------------ */
/* Example game (shown on first launch so the board isn't empty)       */
/* ------------------------------------------------------------------ */
function sampleState() {
  const s = DEFAULT_STATE();
  s.config.home = 'Example Hawks';
  s.config.away = 'Example Bears';
  // Simple made-up crests so the example shows logos and team colors.
  const crest = (fill, accent, letter) => `data:image/svg+xml;base64,${btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 3 58 12v20c0 15-12 25-26 29C18 57 6 47 6 32V12z" fill="${fill}" stroke="${accent}" stroke-width="4"/><text x="32" y="43" font-family="Arial Black,Arial,sans-serif" font-size="28" font-weight="900" text-anchor="middle" fill="${accent}">${letter}</text></svg>`)}`;
  s.config.colors = { home: '#ffb81c', away: '#0b2346' };
  s.config.logos = { home: crest('#111111', '#ffb81c', 'H'), away: crest('#0b2346', '#ffffff', 'B') };
  const c = parseClock;
  let n = 0;
  const P = (o) => ({ id: `p${++n}`, servedBy: '', infraction: '', coincidental: false, kind: 'minor', duration: 120, ...o });
  s.penalties = [
    P({ team: 'home', player: '12', infraction: 'Tripping', period: 1, clock: c('12:40') }),
    P({ team: 'away', player: '7', infraction: 'Hooking', period: 1, clock: c('3:10') }),
    P({ team: 'away', player: '22', infraction: 'Slashing', period: 1, clock: c('2:30') }),
    P({ team: 'away', player: '4', infraction: 'Interference', period: 1, clock: c('1:45') }),
    P({ team: 'home', player: '30', servedBy: '8', infraction: 'Delay of game', period: 2, clock: c('14:20') }),
    P({ team: 'home', player: '5', kind: 'double', duration: 240, infraction: 'High-sticking', period: 2, clock: c('9:05') }),
    P({ team: 'away', player: '15', kind: 'minor', infraction: 'Head contact', period: 2, clock: c('5:30') }),
    P({ team: 'away', player: '15', kind: 'misconduct', duration: 600, infraction: 'Head contact', period: 2, clock: c('5:30') }),
  ];
  s.goals = [
    { id: `g${++n}`, team: 'away', period: 1, clock: c('11:55'), scorer: '9' },
    { id: `g${++n}`, team: 'away', period: 2, clock: c('8:10'), scorer: '19' },
  ];
  s.seq = n;
  s.lastPeriod = 2;
  return s;
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */
function wire() {
  document.querySelector('.actionbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]');
    if (b) openSheet(b.dataset.add, b.dataset.team);
  });
  $('sheet-close').onclick = closeSheet;
  $('sheet-backdrop').onclick = closeSheet;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });
  $('sheet').addEventListener('submit', submitSheet);
  $('sheet').addEventListener('input', () => { $('f-error').textContent = ''; updatePreview(); });
  bindClockField($('f-clock'));

  // Clock check
  const cc = $('check-clock');
  bindClockField(cc);
  cc.addEventListener('input', () => {
    const s = parseClock(cc.value);
    const len = state.check.period ? periodLengths(state.config)[state.check.period - 1] : null;
    if (s != null && (len == null || s <= len)) {
      state.check.clock = s;
      if (!state.check.period) state.check.period = state.lastPeriod || 1;
      render();
    } else if (cc.value === '') {
      state.check.clock = null;
      render();
    }
  });
  $('check-clear').onclick = () => { state.check = { period: null, clock: null }; cc.value = ''; render(); };

  // Board: show/hide finished
  $('board').addEventListener('click', (e) => {
    const b = e.target.closest('[data-done]');
    if (b) { showDone[b.dataset.done] = !showDone[b.dataset.done]; render(); }
  });

  // Log: delete with two taps
  $('log').addEventListener('click', (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    confirmTap(b, 'Confirm', () => {
      const id = b.dataset.del;
      state.penalties = state.penalties.filter((p) => p.id !== id);
      state.goals = state.goals.filter((g) => g.id !== id);
      render();
      toast('Entry deleted');
    });
  });

  // Export
  $('btn-csv').onclick = downloadCsv;
  $('btn-copy').onclick = copyLog;
  try {
    const probe = new File(['x'], 'x.csv', { type: 'text/csv' });
    if (navigator.canShare?.({ files: [probe] })) { $('btn-share').hidden = false; $('btn-share').onclick = shareCsv; }
  } catch { /* no Web Share */ }

  // Setup
  for (const side of ['home', 'away']) {
    $(`cfg-${side}`).addEventListener('input', (e) => { state.config[side] = e.target.value; render(); });
    $(`cfg-${side}-pick`).addEventListener('change', (e) => {
      const name = e.target.value;
      e.target.value = '';          // the select is an action, not a setting
      if (name) useTeam(side, name);
    });
    $(`cfg-${side}-colors`).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-color]');
      if (b) { state.config.colors[side] = b.dataset.color; render(); }
    });
    // Native picker: 'input' fires while dragging, so only touch CSS variables then;
    // a full render on 'change' (picker closed) avoids rebuilding mid-drag.
    $(`cfg-${side}-custom`).addEventListener('input', (e) => { state.config.colors[side] = e.target.value; applyTeamColors(); });
    $(`cfg-${side}-custom`).addEventListener('change', (e) => { state.config.colors[side] = e.target.value; render(); });
    $(`cfg-${side}-logo`).addEventListener('click', () => $(`cfg-${side}-file`).click());
    $(`cfg-${side}-file`).addEventListener('change', (e) => {
      addLogo(side, e.target.files?.[0]);
      e.target.value = '';           // allow choosing the same file again
    });
    $(`cfg-${side}-logo-remove`).addEventListener('click', () => { state.config.logos[side] = null; render(); toast('Logo removed'); });
    $(`cfg-${side}-save`).addEventListener('click', () => saveTeamToList(side));
  }

  // Team list
  $('team-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-team-del]');
    if (!b) return;
    confirmTap(b, 'Confirm', () => {
      const next = removeTeam(myTeams, b.dataset.teamDel);
      saveMyTeams(next);
      myTeams = next;
      render();
      toast('Team list updated');
    });
  });
  $('btn-teams-export').onclick = downloadTeams;
  try {
    const probe = new File(['{}'], 'teams.json', { type: 'application/json' });
    if (navigator.canShare?.({ files: [probe] })) { $('btn-teams-share').hidden = false; $('btn-teams-share').onclick = shareTeams; }
  } catch { /* no Web Share */ }
  $('cfg-periods').addEventListener('click', (e) => {
    const b = e.target.closest('[data-count]');
    if (!b) return;
    const n = Number(b.dataset.count);
    const cfg = state.config;
    if (n === cfg.periods.length) return;
    if (n < cfg.periods.length && (usesPeriod(3) || (cfg.otLength && usesPeriod(4)))) {
      return toast('Delete the entries in the removed period first.');
    }
    cfg.periods = n === 2 ? cfg.periods.slice(0, 2) : [...cfg.periods, cfg.periods[1] ?? 900];
    render();
  });
  $('cfg-periods').addEventListener('change', (e) => {
    const i = e.target.dataset.pi;
    if (i == null) return;
    const s = parseClock(e.target.value);
    if (s == null || s < 60) { toast('Use a length like 15:00.'); e.target.value = fmtClock(state.config.periods[i]); return; }
    // Existing entries must still fit inside the shortened period.
    const latest = [...state.penalties, ...state.goals].filter((x) => x.period === Number(i) + 1).map((x) => x.clock);
    if (latest.some((cl) => cl > s)) { toast('An entry is earlier than that in the period. Fix it first.'); e.target.value = fmtClock(state.config.periods[i]); return; }
    state.config.periods[i] = s;
    e.target.blur();
    render();
  });
  $('cfg-wake').addEventListener('change', (e) => { state.config.wake = e.target.checked; applyWake(); save(); });
  document.addEventListener('visibilitychange', applyWake);

  $('btn-new').onclick = (e) => confirmTap(e.currentTarget, 'Tap again to clear', () => {
    const keep = state.config;
    state = DEFAULT_STATE();
    // Keep periods/OT/minor length; reset team identity (pick from the team list).
    state.config = { ...keep, home: 'Home', away: 'Away', colors: { ...DEFAULT_COLORS }, logos: { home: null, away: null } };
    showDone = { home: false, away: false };
    render();
    toast('New game started');
  });
  $('btn-sample').onclick = (e) => confirmTap(e.currentTarget, 'Tap again to replace', () => {
    state = sampleState();
    render();
    toast('Example game loaded');
  });
}

/* ------------------------------------------------------------------ */
/* Collapsible sections: remember open/closed per phone (convenience    */
/* only; if storage is blocked they just use the defaults)             */
/* ------------------------------------------------------------------ */
const UI_KEY = 'penaltybox.ui.v1';
const SECTION_DEFAULTS = { 'sec-setup': true, 'sec-teams': false };

function initSections() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {}; } catch { /* ignore */ }
  for (const [id, def] of Object.entries(SECTION_DEFAULTS)) {
    const el = $(id);
    el.open = typeof saved[id] === 'boolean' ? saved[id] : def;
    el.addEventListener('toggle', () => {
      try {
        const cur = JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {};
        cur[id] = el.open;
        localStorage.setItem(UI_KEY, JSON.stringify(cur));
      } catch { /* ignore */ }
    });
  }
}

/* ------------------------------------------------------------------ */
/* Offline support: register the service worker on real hosting only   */
/* ------------------------------------------------------------------ */
function registerSW() {
  try {
    const okHost = location.protocol === 'https:' || location.hostname === 'localhost';
    if ('serviceWorker' in navigator && okHost && window.self === window.top) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  } catch { /* sandboxed */ }
}

buildTeamCards();
initSections();
wire();
render();
applyWake();
registerSW();
// Club team list arrives asynchronously (network or offline cache); re-render when it does.
loadClubTeams().then((teams) => { if (teams.length) { clubTeams = teams; render(); } });
