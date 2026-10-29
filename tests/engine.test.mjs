// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClock, fmtClock, toElapsed, toClock, fmtPosition, computeSchedule, snapshot,
} from '../js/engine.js';

const cfg = { periods: [900, 900, 900], otLength: 0 };          // 3 x 15:00
const cfgOT = { periods: [780, 780, 780], otLength: 300 };       // 3 x 13:00 + 5:00 OT

let n = 0;
const pen = (o) => ({ id: `p${++n}`, team: 'home', player: '10', servedBy: '', kind: 'minor',
  duration: 120, period: 1, clock: 600, coincidental: false, ...o });
const goal = (o) => ({ id: `g${++n}`, team: 'away', period: 1, clock: 0, ...o });
const byId = (s, id) => s.penalties.find((p) => p.id === id);
const pos = (c, e) => fmtPosition(c, e);

test('parseClock accepts common entry styles', () => {
  assert.equal(parseClock('12:34'), 754);
  assert.equal(parseClock('1234'), 754);
  assert.equal(parseClock('934'), 574);
  assert.equal(parseClock('45'), 45);
  assert.equal(parseClock('0:05'), 5);
  assert.equal(parseClock('1:75'), null);
  assert.equal(parseClock('abc'), null);
  assert.equal(fmtClock(65), '1:05');
});

test('elapsed <-> clock round trip, boundary shows end of period', () => {
  assert.equal(toElapsed(cfg, 2, 900), 900);
  assert.deepEqual(toClock(cfg, 900), { period: 1, remaining: 0, beyond: false });
  assert.equal(pos(cfg, toElapsed(cfg, 2, 542)), 'P2 9:02');
  assert.equal(pos(cfg, 2800), 'after P3 (+1:40)');
  assert.equal(pos(cfgOT, 780 * 3 + 100), 'OT 3:20');
});

test('simple minor expires two minutes later', () => {
  const p = pen({ period: 2, clock: parseClock('10:30') });
  const s = computeSchedule(cfg, [p]);
  assert.equal(pos(cfg, byId(s, p.id).end), 'P2 8:30');
});

test('minor carries over into the next period', () => {
  const p = pen({ period: 1, clock: 45 });
  const s = computeSchedule(cfg, [p]);
  assert.equal(pos(cfg, byId(s, p.id).end), 'P2 13:45');
});

test('penalty assessed at 0:00 starts with next period', () => {
  const p = pen({ period: 1, clock: 0 });
  const s = computeSchedule(cfg, [p]);
  assert.equal(pos(cfg, byId(s, p.id).end), 'P2 13:00');
});

test('1:30 youth minor', () => {
  const p = pen({ duration: 90, period: 3, clock: parseClock('5:00') });
  assert.equal(pos(cfg, computeSchedule(cfg, [p]).penalties[0].end), 'P3 3:30');
});

test('third strength penalty is delayed until the first expires', () => {
  const a = pen({ player: '4', clock: 600 });
  const b = pen({ player: '7', clock: 570 });
  const c = pen({ player: '9', clock: 540 });
  const s = computeSchedule(cfg, [a, b, c]);
  assert.equal(pos(cfg, byId(s, a.id).end), 'P1 8:00');
  assert.equal(pos(cfg, byId(s, c.id).start), 'P1 8:00');   // starts when #4 out
  assert.equal(pos(cfg, byId(s, c.id).end), 'P1 6:00');
  assert.equal(byId(s, c.id).delayed, true);
});

test('same player serves consecutive penalties', () => {
  const a = pen({ player: '12', clock: 600 });
  const b = pen({ player: '12', clock: 600 });
  const s = computeSchedule(cfg, [a, b]);
  assert.equal(pos(cfg, byId(s, b.id).start), 'P1 8:00');
  assert.equal(pos(cfg, byId(s, b.id).end), 'P1 6:00');
});

test('minor + misconduct: misconduct starts when minor ends, no strength effect', () => {
  const a = pen({ player: '12', clock: 600 });
  const m = pen({ player: '12', kind: 'misconduct', duration: 600, clock: 600 });
  const other = pen({ player: '3', clock: 590 });
  const third = pen({ player: '5', clock: 580 });
  const s = computeSchedule(cfg, [a, m, other, third]);
  assert.equal(pos(cfg, byId(s, m.id).start), 'P1 8:00');
  assert.equal(pos(cfg, byId(s, m.id).end), 'P2 13:00');
  // Misconduct does not occupy a strength slot: #5 starts when #12's minor ends
  assert.equal(pos(cfg, byId(s, third.id).start), 'P1 8:00');
});

test('power-play goal releases the minor', () => {
  const p = pen({ clock: 600 });
  const g = goal({ team: 'away', clock: 550 });
  const s = computeSchedule(cfg, [p], [g]);
  assert.equal(byId(s, p.id).endReason, 'released');
  assert.equal(pos(cfg, byId(s, p.id).end), 'P1 9:10');
});

test('shorthanded goal releases nothing', () => {
  const p = pen({ clock: 600 });
  const g = goal({ team: 'home', clock: 550 });
  const s = computeSchedule(cfg, [p], [g]);
  assert.notEqual(byId(s, p.id).endReason, 'released');
  assert.equal(pos(cfg, byId(s, p.id).end), 'P1 8:00');
});

test('major is not released by a power-play goal', () => {
  const p = pen({ kind: 'major', duration: 300, clock: 600 });
  const g = goal({ team: 'away', clock: 550 });
  const s = computeSchedule(cfg, [p], [g]);
  assert.equal(pos(cfg, byId(s, p.id).end), 'P1 5:00');
});

test('major + minor: PPG releases the minor only', () => {
  const maj = pen({ player: '2', kind: 'major', duration: 300, clock: 600 });
  const min = pen({ player: '8', clock: 590 });
  const g = goal({ clock: 550 });
  const s = computeSchedule(cfg, [maj, min], [g]);
  assert.equal(byId(s, min.id).endReason, 'released');
  assert.equal(byId(s, maj.id).endReason, 'expired');
});

test('PPG releases the minor with least time remaining, delayed penalty then starts', () => {
  const a = pen({ player: '4', clock: 600 });
  const b = pen({ player: '7', clock: 580 });
  const c = pen({ player: '9', clock: 570 });   // delayed
  const g = goal({ clock: 540 });
  const s = computeSchedule(cfg, [a, b, c], [g]);
  assert.equal(byId(s, a.id).endReason, 'released');
  assert.equal(pos(cfg, byId(s, c.id).start), 'P1 9:00');
  assert.equal(pos(cfg, byId(s, c.id).end), 'P1 7:00');
});

test('double minor: goal in first half ends first half, second half starts fresh', () => {
  const d = pen({ kind: 'double', duration: 240, clock: 600 });
  const g = goal({ clock: 540 });  // 1:00 into first half
  const s = computeSchedule(cfg, [d], [g]);
  assert.equal(pos(cfg, byId(s, d.id).end), 'P1 7:00');
  assert.equal(byId(s, d.id).endReason, 'expired');
});

test('double minor: goal in second half ends the penalty', () => {
  const d = pen({ kind: 'double', duration: 240, clock: 600 });
  const g = goal({ clock: 420 });  // 3:00 in
  const s = computeSchedule(cfg, [d], [g]);
  assert.equal(byId(s, d.id).endReason, 'released');
  assert.equal(pos(cfg, byId(s, d.id).end), 'P1 7:00');
});

test('coincidental penalties do not count for strength or release', () => {
  const h = pen({ team: 'home', clock: 600, coincidental: true });
  const a = pen({ team: 'away', clock: 600, coincidental: true });
  const g = goal({ team: 'away', clock: 550 });
  const s = computeSchedule(cfg, [h, a], [g]);
  assert.notEqual(byId(s, h.id).endReason, 'released');
});

test('equal strength (one minor each, not coincidental) goal releases nothing', () => {
  const h = pen({ team: 'home', player: '1', clock: 600 });
  const a = pen({ team: 'away', player: '2', clock: 600 });
  const g = goal({ team: 'away', clock: 550 });
  const s = computeSchedule(cfg, [h, a], [g]);
  assert.notEqual(byId(s, h.id).endReason, 'released');
});

test('served-by: goalie penalty served by teammate', () => {
  const p = pen({ player: '30', servedBy: '14', clock: 600 });
  const q = pen({ player: '14', clock: 590 });   // the server's own penalty queues behind
  const s = computeSchedule(cfg, [p, q]);
  assert.equal(pos(cfg, byId(s, q.id).start), 'P1 8:00');
});

test('ejection is log-only', () => {
  const p = pen({ kind: 'ejection', duration: 0 });
  const s = computeSchedule(cfg, [p]);
  assert.equal(byId(s, p.id).endReason, 'ejected');
});

test('period length change re-flows carry-over', () => {
  const p = pen({ period: 2, clock: 30 });
  const shortP3 = { periods: [900, 900, 600], otLength: 0 };
  const s = computeSchedule(shortP3, [p]);
  assert.equal(pos(shortP3, byId(s, p.id).end), 'P3 8:30');
});

test('snapshot shows penalty clock remaining and strength', () => {
  const a = pen({ player: '4', clock: 600 });
  const b = pen({ player: '7', clock: 580 });
  const c = pen({ player: '9', clock: 570 });
  const s = computeSchedule(cfg, [a, b, c]);
  const snap = snapshot(s, toElapsed(cfg, 1, 550));
  assert.equal(snap.strength.home, 3);
  assert.equal(snap.home.length, 3);
  assert.equal(snap.home.find((x) => x.id === a.id).remaining, 70);
  assert.equal(snap.home.find((x) => x.id === c.id).pending, true);
});

test('carry past regulation without OT is flagged', () => {
  const p = pen({ period: 3, clock: 60 });
  const s = computeSchedule(cfg, [p]);
  assert.equal(toClock(cfg, byId(s, p.id).end).beyond, true);
});

test('coincidental minors each side + extra away minor = 5 v 4', () => {
  const h = pen({ team: 'home', player: '4', clock: 600, coincidental: true });
  const a = pen({ team: 'away', player: '7', clock: 600, coincidental: true });
  const x = pen({ team: 'away', player: '9', clock: 540 });
  const s = computeSchedule(cfg, [h, a, x]);
  const snap = snapshot(s, toElapsed(cfg, 1, 530));
  assert.deepEqual(snap.strength, { home: 5, away: 4 });
  assert.equal(snap.home.length, 1);
  assert.equal(snap.away.length, 2);
});
