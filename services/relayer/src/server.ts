// The relayer's HTTP surface. It listens on this host only; the web server in front of it passes
// the caller's network address in X-Forwarded-For, which is believed only when the connection
// itself comes from this host. Every refusal is { error: code } with a status; nothing of an
// internal error reaches the caller.
import type { IncomingMessage, ServerResponse } from "node:http";

import { Refused } from "./refused.ts";
import type { Relayer } from "./relayer.ts";

const BODY_MOST = 16_384; // bytes

async function bodyOf(req: IncomingMessage, most: number): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    size += (part as Buffer).length;
    if (size > most) throw new Refused(413, "too-long");
    parts.push(part as Buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
  } catch {
    throw new Refused(400, "bad-request");
  }
}

async function jsonOf(req: IncomingMessage): Promise<unknown> {
  const text = await bodyOf(req, BODY_MOST);
  try {
    return JSON.parse(text);
  } catch {
    throw new Refused(400, "bad-request");
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** The caller's network address: the last one the web server on this host added, or the connection's own. */
export function callerOf(req: IncomingMessage): string {
  const direct = req.socket.remoteAddress ?? "";
  const forwarded = req.headers["x-forwarded-for"];
  if (LOOPBACK.has(direct) && typeof forwarded === "string") {
    const last = forwarded.split(",").pop()!.trim();
    if (/^[0-9a-fA-F:.]{2,45}$/.test(last)) return last;
  }
  return direct;
}

export function handler(app: Relayer, log: (line: Record<string, unknown>) => void = () => {}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const answer = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://relayer");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const m = req.method ?? "GET";
      let at: RegExpExecArray | null;

      if (m === "GET" && path === "/") return answer(200, await app.info());
      if (m === "POST" && path === "/handouts") return answer(200, await app.handout(await jsonOf(req), callerOf(req)));
      if (m === "POST" && path === "/fees") return answer(200, await app.topUp(await jsonOf(req)));
      if (m === "POST" && (at = /^\/vaults\/([a-z][a-z0-9-]{0,30})\/defaults$/.exec(path))) return answer(200, await app.declareDefault(at[1], callerOf(req)));
      if (m === "GET" && (at = /^\/accounts\/(0x[0-9a-fA-F]{40})$/.exec(path))) return answer(200, await app.account(at[1]));
      if (m === "POST" && path === "/transactions") return answer(200, await app.relay(await jsonOf(req)));
      return answer(404, { error: "not-found" });
    } catch (e) {
      if (e instanceof Refused) return answer(e.status, { error: e.code, ...e.extra });
      log({ what: "error", path: req.url, why: e instanceof Error ? e.message : String(e) });
      return answer(500, { error: "internal" }); // nothing of the error goes to the caller
    }
  };
}
