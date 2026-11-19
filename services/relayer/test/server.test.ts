// Every value in this file is invented. None is a reading of any market.
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";

import { callerOf, handler } from "../src/server.ts";
import { Refused } from "../src/refused.ts";

const ADDR = "0x00000000000000000000000000000000000000a1";

/** A stand-in relayer that records what the HTTP layer called and with what. */
function fakeApp() {
  const seen: Record<string, unknown> = {};
  return {
    seen,
    info: async () => ({ chainId: 5042002 }),
    handout: async (body: unknown, ip: string) => { seen.handout = { body, ip }; return { tx: "0x1" }; },
    topUp: async (body: unknown) => { seen.topUp = { body }; return { tx: "0x2" }; },
    declareDefault: async (name: string, ip: string) => { seen.default = { name, ip }; return { tx: "0x3" }; },
    account: async (address: string) => { seen.account = { address }; return { nonce: "3" }; },
    relay: async (body: unknown) => {
      seen.relay = { body };
      if ((body as { raw?: string }).raw === "boom") throw new Error("a secret internal detail");
      return { tx: "0x4" };
    },
  };
}

async function serve(app: ReturnType<typeof fakeApp>): Promise<{ base: string; server: Server }> {
  const server = createServer(handler(app as never));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { base: "http://127.0.0.1:" + (server.address() as { port: number }).port, server };
}

test("each route reaches its method with its path and body", async () => {
  const app = fakeApp();
  const { base, server } = await serve(app);
  after(() => server.close());
  const get = async (p: string) => (await fetch(base + p)).json();
  const post = async (p: string, body: unknown) => (await fetch(base + p, { method: "POST", body: JSON.stringify(body) })).json();

  assert.deepEqual(await get("/"), { chainId: 5042002 });
  assert.deepEqual(await post("/handouts", { address: ADDR, device: "d" }), { tx: "0x1" });
  assert.deepEqual(app.seen.handout, { body: { address: ADDR, device: "d" }, ip: "127.0.0.1" });
  assert.deepEqual(await post("/fees", { address: ADDR }), { tx: "0x2" });
  assert.deepEqual(await post("/vaults/stage/defaults", {}), { tx: "0x3" });
  assert.deepEqual(app.seen.default, { name: "stage", ip: "127.0.0.1" });
  assert.deepEqual(await get("/accounts/" + ADDR), { nonce: "3" });
  assert.deepEqual(await post("/transactions", { raw: "0xabc" }), { tx: "0x4" });
});

test("an unknown path or the wrong method is 404 not-found", async () => {
  const { base, server } = await serve(fakeApp());
  after(() => server.close());
  assert.equal((await fetch(base + "/nope")).status, 404);
  assert.equal((await fetch(base + "/handouts")).status, 404); // GET on a POST route
  assert.equal((await fetch(base + "/accounts/not-an-address")).status, 404);
});

test("a body over 16 KB is refused", async () => {
  const { base, server } = await serve(fakeApp());
  after(() => server.close());
  const res = await fetch(base + "/transactions", { method: "POST", body: "x".repeat(20_000) });
  assert.equal(res.status, 413);
});

test("a body that is not JSON is a bad request", async () => {
  const { base, server } = await serve(fakeApp());
  after(() => server.close());
  const res = await fetch(base + "/handouts", { method: "POST", body: "{not json" });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "bad-request" });
});

test("an internal error is 500 with no text of it", async () => {
  const { base, server } = await serve(fakeApp());
  after(() => server.close());
  const res = await fetch(base + "/transactions", { method: "POST", body: JSON.stringify({ raw: "boom" }) });
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.equal(text, JSON.stringify({ error: "internal" }));
  assert.ok(!text.includes("secret"));
});

test("a Refused thrown by a method carries its status, code and extra", async () => {
  const app = fakeApp();
  app.relay = async () => { throw new Refused(409, "refused", { why: "NotYet" }); };
  const { base, server } = await serve(app);
  after(() => server.close());
  const res = await fetch(base + "/transactions", { method: "POST", body: JSON.stringify({ raw: "0x" }) });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "refused", why: "NotYet" });
});

test("callerOf believes X-Forwarded-For only from this host", () => {
  const req = (remote: string, xff?: string): IncomingMessage =>
    ({ socket: { remoteAddress: remote }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } }) as unknown as IncomingMessage;
  assert.equal(callerOf(req("127.0.0.1", "203.0.113.7")), "203.0.113.7");
  assert.equal(callerOf(req("127.0.0.1", "10.0.0.1, 203.0.113.9")), "203.0.113.9"); // the last one the host added
  assert.equal(callerOf(req("203.0.113.1", "198.51.100.1")), "203.0.113.1"); // not from this host: the forwarded header is ignored
  assert.equal(callerOf(req("127.0.0.1")), "127.0.0.1");
});
