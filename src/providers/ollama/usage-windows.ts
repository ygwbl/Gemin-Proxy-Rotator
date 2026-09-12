// Ported from the ollama-rotator project (same author) into the
// tuxevil-rotator provider layer.
// ── Quota window math ────────────────────────────────────────────────
// Ollama Cloud usage limits:
//  - weekly: fixed calendar window that always runs; resets every Monday
//    00:00 UTC (which is Sunday 19:00 in GMT-5). The reset moment is
//    deterministic — no heuristic needed, and using the pool never
//    "starts" or shifts the window.
//  - session: child of the weekly window. It is inactive until the first
//    request, and each activation lasts exactly 5 hours (rolling from
//    when the window opened).
//
// The session window start is only observed indirectly via the usage
// fraction, so callers anchor it at the moment usage first becomes > 0
// (or the poll that detects a drop after a reset).

export const SESSION_WINDOW_MS = 5 * 3600 * 1000;
export const WEEKLY_WINDOW_MS = 7 * 24 * 3600 * 1000;

// Resets take place at 00:00 UTC on Monday (end of Sunday UTC).
const WEEKLY_RESET_UTC_WEEKDAY = 1; // Date.prototype.getUTCDay(): 1 = Monday

// Start of the current weekly window (the Monday 00:00 UTC at or before now).
export function weeklyStartUtcMs(now: number = Date.now()): number {
  const date = new Date(now);
  const dayOffset = (date.getUTCDay() - WEEKLY_RESET_UTC_WEEKDAY + 7) % 7;
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - dayOffset,
  );
}

export function nextWeeklyResetMs(now: number = Date.now()): number {
  return weeklyStartUtcMs(now) + WEEKLY_WINDOW_MS;
}

export function sessionWindowEndMs(startMs: number): number {
  return startMs + SESSION_WINDOW_MS;
}

// Remaining time on the current session window, clamped to >= 0.
export function sessionRemainingMs(
  startMs: number,
  now: number = Date.now(),
): number {
  return Math.max(0, sessionWindowEndMs(startMs) - now);
}