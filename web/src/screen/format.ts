// Money on the screen. Micros are millionths of a dollar, as every amount from the ledger and the
// score library is. A reward figure reads as whole dollars with thousands separators once it is $100
// or more, and with two decimals under that, so the small figures (a pool's minute share) keep their
// cents and the large ones (a day's whole program) stay legible.

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** A count of contracts, with thousands separators. */
export function count(n: number): string {
  return whole.format(n);
}

/** A score: whole with thousands separators from 100 up, two decimals under it. */
export function score(n: number): string {
  return n >= 100 ? whole.format(Math.round(n)) : n.toFixed(2);
}

/** A dollar amount from micros, without the sign; the caller writes the `$`. */
export function dollars(micros: number): string {
  const value = micros / 1_000_000;
  return value >= 100 ? whole.format(Math.round(value)) : value.toFixed(2);
}

/** A dollar amount for a figure that is often under a cent (a per-minute share): four decimals
 * under $1, so the small figures keep their worth, and `dollars` from $1 up. Without the sign. */
export function dollarsFine(micros: number): string {
  const value = micros / 1_000_000;
  return value < 1 ? value.toFixed(4) : dollars(micros);
}

// A floor is never shown above itself: the least figures and least shares are cut off at the last
// digit shown, not rounded to it (audit of 2026-11-18, the screen, finding 1).

/** `dollars`, cut off rather than rounded. For a figure given as "at least". */
export function dollarsLeast(micros: number): string {
  const m = Math.max(0, Math.floor(micros));
  return m >= 100_000_000 ? whole.format(Math.floor(m / 1_000_000)) : (Math.floor(m / 10_000) / 100).toFixed(2);
}

/** `dollarsFine`, cut off rather than rounded. */
export function dollarsFineLeast(micros: number): string {
  const m = Math.max(0, Math.floor(micros));
  return m < 1_000_000 ? (Math.floor(m / 100) / 10_000).toFixed(4) : dollarsLeast(m);
}

/** A least share as a percent, cut off: one decimal, three under a tenth of a percent. */
export function pctLeast(share: number): string {
  const v = share * 100;
  return v < 0.1 ? (Math.floor(v * 1000) / 1000).toFixed(3) : (Math.floor(v * 10) / 10).toFixed(1);
}
