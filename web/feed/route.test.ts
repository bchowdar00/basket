// Every value in this file is invented. None is a reading of any market.
import { expect, test } from "vitest";
import { gzipSync } from "node:zlib";
import { gzipMemberStarts, parseLedgerPass, readMembers, recentPasses } from "./route.ts";

const member = (obj: unknown): Buffer => gzipSync(Buffer.from(JSON.stringify(obj) + "\n", "utf8"));

test("gzip member starts are the offsets of the 1f 8b 08 magic", () => {
  const a = member({ i: 1 }), b = member({ i: 2 }), c = member({ i: 3 });
  const buf = Buffer.concat([a, b, c]);
  expect(gzipMemberStarts(buf)).toEqual([0, a.length, a.length + b.length]);
});

test("each member inflates on its own and parses to one read line", () => {
  const buf = Buffer.concat([member({ url: "one", atMs: 1 }), member({ url: "two", atMs: 2 })]);
  expect(readMembers(buf)).toEqual([{ url: "one", atMs: 1 }, { url: "two", atMs: 2 }]);
});

test("a partial lead-in and a false magic are skipped, the whole members recovered", () => {
  const a = member({ url: "g1" }), b = member({ url: "g2" });
  // six bytes that open like a member but carry no body: an inflate that fails and is skipped.
  const falseStart = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00]);
  const buf = Buffer.concat([falseStart, a, b]);
  expect(readMembers(buf)).toEqual([{ url: "g1" }, { url: "g2" }]);
});

test("a ledger line is a pass only when its row's kind is pass", () => {
  expect(parseLedgerPass('{"row":{"kind":"pass","atMs":10}}')).toEqual({ kind: "pass", atMs: 10 });
  expect(parseLedgerPass('{"row":{"kind":"market","atMs":10}}')).toBeNull();
  expect(parseLedgerPass("not json")).toBeNull();
  expect(parseLedgerPass("")).toBeNull();
});

test("only the pass rows of the last seven days are kept", () => {
  const now = 7 * 24 * 3_600_000 + 1_000;
  const day = 24 * 3_600_000;
  const lines = [
    JSON.stringify({ row: { kind: "pass", atMs: now - day } }),
    JSON.stringify({ row: { kind: "pass", atMs: now - 8 * day } }), // older than a week: left out
    JSON.stringify({ row: { kind: "market", atMs: now } }), // not a pass
  ];
  const got = recentPasses(lines, now);
  expect(got).toHaveLength(1);
  expect(got[0].atMs).toBe(now - day);
});
