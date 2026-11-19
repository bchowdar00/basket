// Gemini takes its snapshot at each whole minute (its rules). The screen counts to the next one.
const MINUTE = 60_000;

/** The next whole minute after `nowMs`; at a mark itself, the one after it. */
export function nextMarkMs(nowMs: number): number {
  return (Math.floor(nowMs / MINUTE) + 1) * MINUTE;
}

export function msToMark(nowMs: number): number {
  return nextMarkMs(nowMs) - nowMs;
}
