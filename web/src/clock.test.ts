import { expect, test } from "vitest";
import { msToMark, nextMarkMs } from "./clock.ts";

test("the clock counts to the next whole minute", () => {
  const t = Date.UTC(2026, 10, 17, 18, 0, 30, 250);
  expect(nextMarkMs(t)).toBe(Date.UTC(2026, 10, 17, 18, 1, 0));
  expect(msToMark(t)).toBe(29_750);
});

test("at the mark itself the next mark is a minute on", () => {
  const t = Date.UTC(2026, 10, 17, 18, 1, 0);
  expect(nextMarkMs(t)).toBe(t + 60_000);
  expect(msToMark(t)).toBe(60_000);
});
