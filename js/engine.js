/**
 * Penalty Box — rules engine (pure, no DOM).
 *
 * Model: every game-clock reading (period + countdown time remaining) is
 * converted to ELAPSED game seconds. Penalty math then becomes simple
 * addition, and carry-over between periods falls out for free. Results are
 * converted back to (period, clock) for display.
 *
 * Inputs are stored raw (period + clock) and the whole schedule is
 * recomputed from scratch on every change. This keeps the engine stateless:
 * edit a period length mid-game, delete a goal, add a late entry — the
 * schedule is always consistent.
 */

/** Penalty kinds and how each one behaves on the clock. */
export const KINDS = {
  minor:      { label: 'Minor',        strength: true,  releasable: true,  segments: 1 },
  double:     { label: 'Double minor', strength: true,  releasable: true,  segments: 2 },
  major:      { label: 'Major',        strength: true,  releasable: false, segments: 1 },
  misconduct: { label: 'Misconduct',   strength: false, releasable: false, segments: 1 },
  ejection:   { label: 'Game misc. / Match', strength: false, releasable: false, segments: 1, noClock: true },
};

export const SKATERS = 5;      // skaters per side at full strength
export const MAX_SHORT = 2;    // a team is never reduced below SKATERS - MAX_SHORT

/* ------------------------------------------------------------------ */
/* Clock conversion                                                    */
/* ------------------------------------------------------------------ */

/**
 * Parse user clock input. Accepts "12:34", "1234", "934", "45", "1:05".
 * Returns seconds, or null if unparseable / seconds >= 60.
 */
export function parseClock(text) {
  if (text == null) return null;
  const s = String(text).trim();
  let m, sec;
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    [m, sec] = s.split(':').map(Number);
  } else if (/^\d{1,4}$/.test(s)) {
    // Digits only: last two digits are seconds ("934" -> 9:34, "45" -> 0:45)
    const n = s.padStart(3, '0');
    m = Number(n.slice(0, -2));
    sec = Number(n.slice(-2));
  } else {
    return null;
  }
  if (sec > 59) return null;
  return m * 60 + sec;
}

/** 754 -> "12:34" */
export function fmtClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Period label for display. Index is 1-based; the last slot is OT when enabled. */
export function periodLabel(config, period) {
  return period > config.periods.length ? 'OT' : `P${period}`;
}

/** Ordered list of playable period lengths (regulation + optional OT). */
export function periodLengths(config) {
  const list = [...config.periods];
  if (config.otLength > 0) list.push(config.otLength);
  return list;
}

/**
 * (period, clockRemaining) -> elapsed seconds since game start.
 * period is 1-based.
 */
export function toElapsed(config, period, remaining) {
  const lens = periodLengths(config);
  let before = 0;
  for (let i = 0; i < period - 1; i++) before += lens[i] ?? 0;
  const len = lens[period - 1] ?? 0;
  return before + (len - remaining);
}

/**
 * elapsed seconds -> { period, remaining, beyond }
 * A time landing exactly on a period boundary is shown as 0:00 of the
 * period that just ended ("expires at end of P2") — that is how a clock
 * operator thinks about it. beyond=true means past the last playable period.
 */
export function toClock(config, elapsed) {
  const lens = periodLengths(config);
  let start = 0;
  for (let i = 0; i < lens.length; i++) {
    const end = start + lens[i];
    if (elapsed <= end) {
      return { period: i + 1, remaining: end - elapsed, beyond: false };
    }
    start = end;
  }
  return { period: lens.length, remaining: 0, beyond: true, over: elapsed - start };
}

/** Human-readable clock position, e.g. "P2 8:42", "OT 3:10", "after P3 (+1:12)". */
export function fmtPosition(config, elapsed) {
  const c = toClock(config, elapsed);
  if (c.beyond) return `after ${periodLabel(config, c.period)} (+${fmtClock(c.over)})`;
  return `${periodLabel(config, c.period)} ${fmtClock(c.remaining)}`;
}

/* ------------------------------------------------------------------ */
/* Schedule computation                                                */
/* ------------------------------------------------------------------ */

/**
 * Compute when every penalty actually starts and ends.
 *
 * @param {object} config  { periods: number[] (seconds), otLength: number }
 * @param {Array}  penalties  [{ id, team:'home'|'away', player, servedBy, kind,
 *                              duration, period, clock, coincidental }]
 * @param {Array}  goals      [{ id, team, period, clock }]
 * @returns {{ penalties: Array, goals: Array }} copies annotated with
 *   start/end (elapsed), status, endReason, waitReason, releasedBy, etc.
 */
export function computeSchedule(config, penalties, goals = []) {
  // Working copies, in entry order. Entry order breaks ties when two
  // penalties are assessed at the same stoppage.
  const ps = penalties.map((p, order) => {
    const kind = KINDS[p.kind] ?? KINDS.minor;
    return {
      ...p,
      order,
      server: String(p.servedBy || p.player || '?'),
      assessedAt: toElapsed(config, p.period, p.clock),
      strength: kind.strength && !p.coincidental,
      releasable: kind.releasable && !p.coincidental,
      segments: kind.segments,
      noClock: !!kind.noClock,
      status: 'waiting',
      start: null, end: null, projEnd: null,
      segIndex: 0, segStart: null,
      endReason: null, releasedBy: null, waitReason: null,
    };
  });

  const gs = goals
    .map((g, order) => ({ ...g, order, at: toElapsed(config, g.period, g.clock), released: null }))
    .sort((a, b) => a.at - b.at || a.order - b.order);

  // Ejections are log-only: no clock time is served.
  for (const p of ps) {
    if (p.noClock) {
      p.status = 'done';
      p.start = p.end = p.assessedAt;
      p.endReason = 'ejected';
    }
  }

  const running = (team) => ps.filter((p) => p.status === 'running' && p.team === team);
  const runningStrength = (team) => running(team).filter((p) => p.strength).length;
  const onIce = (team) => SKATERS - Math.min(MAX_SHORT, runningStrength(team));
  const other = (team) => (team === 'home' ? 'away' : 'home');

  /** Length of one segment (a double minor is two back-to-back halves). */
  const segLen = (p) => p.duration / p.segments;

  const startPenalty = (p, t) => {
    p.status = 'running';
    p.start = t;
    p.segIndex = 0;
    p.segStart = t;
    p.projEnd = t + p.duration;
    p.waitReason = null;
  };

  /**
   * Why can't p start yet? Returns null if it can.
   *  - same server already serving (or queued ahead): penalties run consecutively
   *  - two strength penalties already running for the team: delayed penalty
   */
  const blocker = (p) => {
    const ahead = ps.find((q) =>
      q !== p && q.team === p.team && q.server === p.server && !q.noClock &&
      (q.status === 'running' || (q.status === 'waiting' &&
        (q.assessedAt < p.assessedAt || (q.assessedAt === p.assessedAt && q.order < p.order)))));
    if (ahead) return { type: 'server', by: ahead };
    if (p.strength && runningStrength(p.team) >= MAX_SHORT) {
      // Will start when the earliest-ending running strength penalty ends.
      const first = running(p.team).filter((q) => q.strength)
        .sort((a, b) => a.projEnd - b.projEnd)[0];
      return { type: 'stacked', by: first };
    }
    return null;
  };

  /** Start everything that is eligible at time t (repeat until stable). */
  const startEligible = (t) => {
    let changed = true;
    while (changed) {
      changed = false;
      const waiting = ps.filter((p) => p.status === 'waiting' && p.assessedAt <= t)
        .sort((a, b) => a.assessedAt - b.assessedAt || a.order - b.order);
      for (const p of waiting) {
        const b = blocker(p);
        if (!b) { startPenalty(p, t); changed = true; }
      }
    }
  };

  /** Power-play goal handling at time t. */
  const applyGoal = (g, t) => {
    const shortTeam = other(g.team);
    if (onIce(g.team) <= onIce(shortTeam)) return; // not a power-play goal
    // Release the releasable penalty with the least time remaining.
    const candidates = running(shortTeam).filter((p) => p.releasable)
      .sort((a, b) => a.projEnd - b.projEnd || a.order - b.order);
    const p = candidates[0];
    if (!p) return; // shorthanded only by majors: nothing to release
    // Which half of a double minor are we in? (>= : a goal at the exact
    // half-way point lands in the second half.)
    const inFirstHalf = p.segments === 2 && p.segIndex === 0 && t - p.segStart < segLen(p);
    if (inFirstHalf) {
      // Goal during first half of a double minor: first half ends now,
      // second half starts fresh from the goal.
      p.segIndex = 1;
      p.segStart = t;
      p.projEnd = t + segLen(p);
      p.halfReleasedBy = g.id;
    } else {
      p.status = 'done';
      p.end = t;
      p.endReason = 'released';
      p.releasedBy = g.id;
    }
    g.released = p.id;
  };

  // Event loop over elapsed time.
  let goalIdx = 0;
  let t = -Infinity;
  for (let guard = 0; guard < 10000; guard++) {
    const nextAssess = Math.min(...ps.filter((p) => p.status === 'waiting' && p.assessedAt > t).map((p) => p.assessedAt), Infinity);
    const nextEnd = Math.min(...ps.filter((p) => p.status === 'running').map((p) => p.projEnd), Infinity);
    const nextGoal = goalIdx < gs.length ? gs[goalIdx].at : Infinity;
    const next = Math.min(nextAssess, nextEnd, nextGoal);
    if (next === Infinity) break;
    t = next;

    // 1) Expirations at t
    for (const p of ps) {
      if (p.status === 'running' && p.projEnd <= t) {
        p.status = 'done'; p.end = p.projEnd; p.endReason = 'expired';
      }
    }
    // 2) Goals at t (evaluated before new penalties at the same stoppage start)
    while (goalIdx < gs.length && gs[goalIdx].at === t) {
      applyGoal(gs[goalIdx], t);
      goalIdx++;
    }
    // 3) Start anything eligible (new assessments, delayed, queued)
    startEligible(t);
  }

  // Anything still waiting/running has a projected end; annotate wait reasons.
  for (const p of ps) {
    if (p.status === 'running') { p.end = p.projEnd; }
    if (p.status === 'waiting') {
      const b = blocker(p);
      p.waitReason = b ? b.type : null;
    }
  }

  // Record why a penalty started later than it was assessed (for display).
  for (const p of ps) {
    if (p.start != null && p.start > p.assessedAt && !p.noClock) {
      p.delayed = true;
    }
  }

  return { penalties: ps, goals: gs };
}

/**
 * Snapshot at a given elapsed time ("clock check"): what each penalty
 * clock should read and current on-ice strength. Uses the computed schedule.
 */
export function snapshot(schedule, elapsed) {
  const res = { home: [], away: [], strength: { home: SKATERS, away: SKATERS } };
  const short = { home: 0, away: 0 };
  for (const p of schedule.penalties) {
    if (p.noClock || p.start == null) continue;
    if (p.start <= elapsed && elapsed < p.end) {
      res[p.team].push({ id: p.id, remaining: p.end - elapsed, player: p.player, servedBy: p.servedBy });
      if (p.strength) short[p.team]++;
    } else if (p.assessedAt <= elapsed && p.start > elapsed) {
      res[p.team].push({ id: p.id, remaining: p.end - p.start, player: p.player, servedBy: p.servedBy, pending: true });
    }
  }
  res.strength.home = SKATERS - Math.min(MAX_SHORT, short.home);
  res.strength.away = SKATERS - Math.min(MAX_SHORT, short.away);
  return res;
}
