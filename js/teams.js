/**
 * Penalty Box — team identity helpers (no app state).
 *
 *  - Color math: readable text on a team color, and a readable version of
 *    the team color for text on the app's dark or light background.
 *  - Logo processing: any image file -> small square data URL.
 *  - Team list: per-device "My teams" in localStorage, plus an optional
 *    club-wide teams.json served next to the app (shared via GitHub).
 */

/* ------------------------------------------------------------------ */
/* Color                                                               */
/* ------------------------------------------------------------------ */

/** Common hockey jersey colors. Custom colors come from the native picker. */
export const PRESETS = [
  { name: 'White', hex: '#ffffff' },   // usual home jersey
  { name: 'Red', hex: '#c8102e' },
  { name: 'Maroon', hex: '#7a1e2e' },
  { name: 'Orange', hex: '#f47a20' },
  { name: 'Gold', hex: '#ffb81c' },
  { name: 'Green', hex: '#00703c' },
  { name: 'Teal', hex: '#00778b' },
  { name: 'Light blue', hex: '#4b9cd3' },
  { name: 'Royal', hex: '#0047bb' },
  { name: 'Navy', hex: '#0b2346' },
  { name: 'Purple', hex: '#5f259f' },
  { name: 'Black', hex: '#111111' },
  { name: 'Silver', hex: '#a2aaad' },
];

export const DEFAULT_COLORS = { home: '#c8102e', away: '#0047bb' };

/** App surfaces the team color must stay readable on (keep in sync with styles.css). */
const SURFACE = { dark: '#141c29', light: '#ffffff' };
const INK = { light: '#ffffff', dark: '#0c121c' };

const HEX_RE = /^#[0-9a-f]{6}$/i;
export const isHex = (s) => typeof s === 'string' && HEX_RE.test(s);
export const WHITE = '#ffffff';

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG relative luminance. */
function luminance(h) {
  const [r, g, b] = rgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Linear blend: t=0 -> a, t=1 -> b. */
function mix(a, b, t) {
  const A = rgb(a), B = rgb(b);
  return hex(A.map((v, i) => v + (B[i] - v) * t));
}

/** Text color to put ON a team-color fill (white or near-black, whichever reads better). */
export function inkFor(color) {
  return contrast(color, INK.light) >= contrast(color, INK.dark) ? INK.light : INK.dark;
}

/**
 * Version of `color` usable as text on `bg`: unchanged if it already
 * reaches the target contrast, otherwise nudged toward white (dark bg)
 * or black (light bg) in small steps until it does.
 */
export function readableOn(color, bg, target = 4.5) {
  if (contrast(color, bg) >= target) return color;
  const toward = luminance(bg) < 0.5 ? '#ffffff' : '#000000';
  for (let t = 0.05; t <= 1; t += 0.05) {
    const c = mix(color, toward, t);
    if (contrast(c, bg) >= target) return c;
  }
  return toward;
}

/** All CSS custom properties for one side, e.g. --home, --home-ink, --home-on-dark. */
export function colorVars(side, color) {
  const c = isHex(color) ? color : DEFAULT_COLORS[side];
  return {
    [`--${side}`]: c,
    [`--${side}-ink`]: inkFor(c),
    [`--${side}-on-dark`]: readableOn(c, SURFACE.dark),
    [`--${side}-on-light`]: readableOn(c, SURFACE.light),
    // White or very pale jerseys need a visible outline on light surfaces.
    [`--${side}-edge`]: contrast(c, SURFACE.light) < 1.6 ? '#8c96a3' : 'transparent',
  };
}

/** True when two jersey colors would be hard to tell apart at a glance. */
export function similarColors(a, b) {
  if (!isHex(a) || !isHex(b)) return false;
  const A = rgb(a), B = rgb(b);
  // "Redmean" weighted distance: a cheap approximation of perceived difference.
  const rm = (A[0] + B[0]) / 2;
  const d = Math.sqrt((2 + rm / 256) * (A[0] - B[0]) ** 2 + 4 * (A[1] - B[1]) ** 2 + (2 + (255 - rm) / 256) * (A[2] - B[2]) ** 2);
  return d < 110;
}

/* ------------------------------------------------------------------ */
/* Logos                                                               */
/* ------------------------------------------------------------------ */

export const LOGO_SIZE = 128;

/**
 * Read an image file and return a LOGO_SIZE square data URL, image fitted
 * inside (no cropping) on a transparent background. WebP where the browser
 * can encode it (much smaller), PNG otherwise.
 */
export async function processLogo(file, size = LOGO_SIZE) {
  if (!file) throw new Error('No file');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Unreadable image'));
      i.src = url;
    });
    // SVGs without explicit dimensions report 0x0: treat them as square.
    let src = img;
    let w = img.naturalWidth || size;
    let h = img.naturalHeight || size;

    // Big photos: halve repeatedly first so the final downscale isn't jagged.
    while (Math.max(w, h) > size * 4) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w / 2));
      c.height = Math.max(1, Math.round(h / 2));
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      src = c; w = c.width; h = c.height;
    }

    const scale = Math.min(size / w, size / h);
    const dw = Math.round(w * scale);
    const dh = Math.round(h * scale);
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, Math.round((size - dw) / 2), Math.round((size - dh) / 2), dw, dh);

    const webp = out.toDataURL('image/webp', 0.85);
    return webp.startsWith('data:image/webp') ? webp : out.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Accept a logo only if it's an embedded image or a plain relative path
 * inside the repo (e.g. "logos/hawks.png"). Anything else is dropped.
 */
export function safeLogo(v) {
  if (typeof v !== 'string' || !v) return null;
  if (/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[a-z0-9+/=]+$/i.test(v)) return v;
  if (/^[\w-]+(\/[\w-]+)*\.(png|jpe?g|webp|gif|svg)$/i.test(v)) return v;
  return null;
}

/* ------------------------------------------------------------------ */
/* Team list                                                           */
/* ------------------------------------------------------------------ */

const LIB_KEY = 'penaltybox.teams.v1';
export const CLUB_FILE = 'teams.json';
export const MAX_NAME = 24;

const keyOf = (name) => name.trim().toLowerCase();

/** Validate one team record from storage or teams.json. Returns null if unusable. */
export function normalizeTeam(t) {
  if (!t || typeof t !== 'object') return null;
  const name = String(t.name ?? '').trim().slice(0, MAX_NAME);
  if (!name) return null;
  return { name, color: isHex(t.color) ? t.color.toLowerCase() : null, logo: safeLogo(t.logo) };
}

export function loadMyTeams() {
  try {
    const list = JSON.parse(localStorage.getItem(LIB_KEY) || '[]');
    return Array.isArray(list) ? list.map(normalizeTeam).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Returns false if the phone refused to store it (storage full or blocked). */
export function saveMyTeams(list) {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Insert or replace by name (case-insensitive). Returns a new array. */
export function upsertTeam(list, team) {
  const t = normalizeTeam(team);
  if (!t) return list;
  const rest = list.filter((x) => keyOf(x.name) !== keyOf(t.name));
  return [...rest, t].sort((a, b) => a.name.localeCompare(b.name));
}

export function removeTeam(list, name) {
  return list.filter((x) => keyOf(x.name) !== keyOf(name));
}

/**
 * Load the club list (teams.json next to index.html). Missing file, bad
 * JSON or no connection all return [] — the club list is optional.
 */
export async function loadClubTeams() {
  try {
    const res = await fetch(CLUB_FILE, { cache: 'no-cache' });
    if (!res.ok) return [];
    const data = await res.json();
    const teams = Array.isArray(data) ? data : data?.teams;
    return Array.isArray(teams) ? teams.map(normalizeTeam).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Club + mine, one entry per name. A team saved on this phone overrides the club copy. */
export function mergeTeams(club, mine) {
  const map = new Map();
  for (const t of club) map.set(keyOf(t.name), { ...t, source: 'club' });
  for (const t of mine) map.set(keyOf(t.name), { ...t, source: map.has(keyOf(t.name)) ? 'club-edited' : 'mine' });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** teams.json contents for the repo. */
export function teamsJson(list) {
  const teams = list.map(({ name, color, logo }) => ({ name, color, logo }));
  return `${JSON.stringify({ version: 1, teams }, null, 2)}\n`;
}
