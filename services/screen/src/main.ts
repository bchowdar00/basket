// The shared reader as a small server. It listens on the local host only; the web server in the same
// container group passes /feed/* to it. Two routes, both GET: /screen (the lists) and /pools (every
// pool read so far). Neither takes anything from the caller, and neither causes a request to Gemini.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { liveFeed } from "../../../web/feed/live.ts";
import { sharedReader } from "./pass.ts";

const dir = process.env.SCREEN_LIVE_DIR ?? "/data/screen-live";
const port = Number(process.env.SCREEN_PORT ?? "8790");
const reader = sharedReader({
  feed: liveFeed({ dir, unreadToo: true }),
  nowMs: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (line) => console.log(new Date().toISOString() + " " + line),
});

// What the reader holds is written to its folder (outside the repository, with the raw answers) as it
// goes, and read back at the start, so a restart shows the last read at once instead of nothing.
const keptFile = join(dir, "held.json");
const save = () => {
  try { mkdirSync(dir, { recursive: true }); writeFileSync(keptFile + ".part", JSON.stringify(reader.dump())); renameSync(keptFile + ".part", keptFile); } catch (e) { console.log("could not write " + keptFile + ": " + String(e)); }
};
try { reader.restore(JSON.parse(readFileSync(keptFile, "utf8"))); console.log("restored " + JSON.stringify(reader.state())); } catch { /* nothing held yet */ }
let saved = -1;
setInterval(() => { const s = reader.state(); if (s.pools > 0 && s.done !== saved) { saved = s.done; save(); } }, 60_000);

const tick = () => { if (reader.due()) { console.log(new Date().toISOString() + " a pass begins"); void reader.runPass().then(() => console.log(new Date().toISOString() + " the pass ended " + JSON.stringify(reader.state()))); } };
tick();
setInterval(tick, 30_000);

createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  if (req.method !== "GET" || (path !== "/screen" && path !== "/pools")) { res.statusCode = 404; res.end(); return; }
  reader.visited();
  const body = path === "/screen" ? reader.screen() : reader.pools();
  if (body === null) { res.statusCode = 503; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: "the first read has not come back yet" })); return; }
  const out = gzipSync(JSON.stringify(body));
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-encoding", "gzip");
  res.setHeader("cache-control", "no-store");
  res.end(out);
}).listen(port, "127.0.0.1", () => console.log("the shared reader listens on 127.0.0.1:" + port + ", keeping raw answers in " + dir));
