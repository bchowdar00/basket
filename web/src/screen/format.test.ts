// Every value in this file is invented. None is a reading of any market.
import { expect, test } from "vitest";
import { dollars, dollarsFine, dollarsFineLeast, dollarsLeast, pctLeast } from "./format.ts";

test("at or over $100 a reward figure is whole dollars with thousands separators", () => {
  expect(dollars(100_000_000)).toBe("100");
  expect(dollars(300_000_000)).toBe("300");
  expect(dollars(1_000_000_000)).toBe("1,000");
  expect(dollars(1_450_000_000)).toBe("1,450");
});

test("under $100 a reward figure keeps two decimals", () => {
  expect(dollars(50_000_000)).toBe("50.00");
  expect(dollars(99_500_000)).toBe("99.50");
  expect(dollars(Math.floor(300_000_000 / 1440))).toBe("0.21"); // a pool's minute share
  expect(dollars(0)).toBe("0.00");
});

test("a sub-cent figure keeps four decimals, and dollarsFine reads as dollars from $1 up", () => {
  expect(dollarsFine(100_000)).toBe("0.1000"); // ten cents
  expect(dollarsFine(2_100)).toBe("0.0021"); // under a cent: a pool's minute
  expect(dollarsFine(0)).toBe("0.0000");
  expect(dollarsFine(1_000_000)).toBe("1.00"); // $1: back to dollars' two decimals
  expect(dollarsFine(99_500_000)).toBe("99.50");
  expect(dollarsFine(300_000_000)).toBe("300"); // whole dollars with separators from $100
});

// Audit of 2026-11-18, the screen, finding 1: a floor is cut off, never rounded up past itself.
test("a least figure and a least share are cut off at the last digit shown", () => {
  expect(dollarsFine(999_960)).toBe("1.0000"); // rounded: over the figure itself
  expect(dollarsFineLeast(999_960)).toBe("0.9999");
  expect(dollarsFineLeast(1_999_999)).toBe("1.99");
  expect(dollarsLeast(99_999_999)).toBe("99.99");
  expect(dollarsLeast(1_450_999_999)).toBe("1,450");
  expect(pctLeast(0.99996)).toBe("99.9");
  expect(pctLeast(0.00099996)).toBe("0.099");
  expect(pctLeast(1)).toBe("100.0");
});
