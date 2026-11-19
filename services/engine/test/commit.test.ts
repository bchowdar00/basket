// Every value in this file is invented. No test reaches a network or a chain.
import test from "node:test";
import assert from "node:assert/strict";

import { asBytes32, committer, keyFromVault, type CommitLine } from "../src/commit.ts";

const h = (c: string) => c.repeat(64);

/** A stand-in sender: each send waits until the test lets it finish, then lands or fails. */
function stand() {
  const asked: string[] = [];
  const pending: { head: string; ok: () => void; fail: (e: Error) => void }[] = [];
  return {
    asked, pending,
    sender: { send: (head: `0x${string}`) => new Promise<`0x${string}`>((res, rej) => { asked.push(head); pending.push({ head, ok: () => res(("0xt" + head.slice(2, 6)) as `0x${string}`), fail: rej }); }) },
  };
}
const flush = () => new Promise((r) => setImmediate(r));

test("C1: a head is sent as bytes32, and the line names its transaction", async () => {
  const s = stand(); const lines: CommitLine[] = [];
  const c = committer(s.sender, (l) => lines.push(l), () => 7);
  c.offer(h("a"));
  await flush(); s.pending[0].ok(); await c.idle();
  assert.deepEqual(s.asked, ["0x" + h("a")]);
  assert.deepEqual(lines, [{ atMs: 7, head: h("a"), tx: "0xtaaaa" }]);
});

test("C2: the same head twice is sent once", async () => {
  const s = stand(); const c = committer(s.sender, () => {}, () => 0);
  c.offer(h("a")); await flush(); s.pending[0].ok(); await c.idle();
  c.offer(h("a")); await c.idle();
  assert.equal(s.asked.length, 1);
});

test("C3: heads offered while a send is out: only the newest is sent next", async () => {
  const s = stand(); const c = committer(s.sender, () => {}, () => 0);
  c.offer(h("a")); c.offer(h("b")); c.offer(h("c"));
  await flush(); assert.equal(s.asked.length, 1);
  s.pending[0].ok(); await flush();
  assert.deepEqual(s.asked, ["0x" + h("a"), "0x" + h("c")]);
  s.pending[1].ok(); await c.idle();
});

test("C4: a failed send is written down, not retried alone; the next head is the retry", async () => {
  const s = stand(); const lines: CommitLine[] = [];
  const c = committer(s.sender, (l) => lines.push(l), () => 1);
  c.offer(h("a")); await flush(); s.pending[0].fail(new Error("no answer")); await c.idle();
  assert.deepEqual(lines, [{ atMs: 1, head: h("a"), error: "no answer" }]);
  assert.equal(s.asked.length, 1);
  c.offer(h("b")); await flush(); s.pending[1].ok(); await c.idle();
  assert.deepEqual(s.asked, ["0x" + h("a"), "0x" + h("b")]);
});

test("C5: after a failure the same head is sent again when offered again", async () => {
  const s = stand(); const c = committer(s.sender, () => {}, () => 0);
  c.offer(h("a")); await flush(); s.pending[0].fail(new Error("x")); await c.idle();
  c.offer(h("a")); await flush(); s.pending[1].ok(); await c.idle();
  assert.equal(s.asked.length, 2);
});

test("C6: a head that is not 64 hex digits is refused before any send and written as an error", async () => {
  const s = stand(); const lines: CommitLine[] = [];
  const c = committer(s.sender, (l) => lines.push(l), () => 0);
  c.offer("abc"); await c.idle();
  assert.equal(s.asked.length, 0);
  assert.equal(lines.length, 1);
  assert.ok("error" in lines[0]);
  assert.throws(() => asBytes32(h("A")));
  assert.equal(asBytes32(h("0")), "0x" + h("0"));
});

test("C7: the key is read with the identity's token and checked; a refusal gives no key", async () => {
  const key = "0x" + "1".repeat(64);
  const urls: string[] = [];
  const f = (async (url: string, init?: { headers?: Record<string, string> }) => {
    urls.push(url);
    if (url.startsWith("http://169.254.169.254/")) { assert.equal(init?.headers?.Metadata, "true"); return new Response(JSON.stringify({ access_token: "tok" })); }
    assert.equal(init?.headers?.authorization, "Bearer tok");
    return url.includes("/secrets/operator-key?") ? new Response(JSON.stringify({ value: key })) : new Response("{}", { status: 403 });
  }) as typeof fetch;
  assert.equal(await keyFromVault({ clientId: "id-1", keyVault: "https://kv.example", secret: "operator-key", fetch: f }), key);
  assert.ok(urls[0].includes("client_id=id-1"));
  await assert.rejects(keyFromVault({ clientId: "id-1", keyVault: "https://kv.example", secret: "other", fetch: f }), /status 403/);
});

test("C8: a line that cannot be written does not stop the sends or escape as a rejection", async () => {
  const s = stand();
  const c = committer(s.sender, () => { throw new Error("disk full"); }, () => 0);
  c.offer(h("a")); await flush(); s.pending[0].ok(); await c.idle();
  c.offer(h("b")); await flush(); s.pending[1].fail(new Error("x")); await c.idle();
  assert.equal(s.asked.length, 2);
});

test("C9: a head offered in the instant a send lands is still sent (review of 2026-11-17)", async () => {
  const s = stand(); const c = committer(s.sender, () => {}, () => 0);
  c.offer(h("a")); await flush();
  s.pending[0].ok(); queueMicrotask(() => c.offer(h("b")));
  await flush(); await flush();
  assert.deepEqual(s.asked, ["0x" + h("a"), "0x" + h("b")]);
  s.pending[1].ok(); await c.idle();
});

test("C10: a head refused before any send leaves the committer free for the next", async () => {
  const s = stand(); const c = committer(s.sender, () => {}, () => 0);
  c.offer("bad"); c.offer(h("a")); await flush();
  assert.deepEqual(s.asked, ["0x" + h("a")]);
  s.pending[0].ok(); await c.idle();
});
