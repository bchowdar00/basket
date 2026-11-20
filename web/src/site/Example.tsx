// The worked example on the one page: who needs the liquidity. It asks Basket's own server for
// what it has read (never the exchange), finds the example's contracts by name and shows what can
// be bought of them now and what Basket's bids would add. A calculation on public books.
import { useEffect, useState } from "react";
import type { Settings } from "@app/score";
import type { PoolRow } from "../../../services/engine/src/gemini.ts";
import { count, dollars } from "../screen/format.ts";
import { basketBids, cover, findLegs, leastBid, type Held } from "./example.ts";

export type ExampleData = { settings: Settings; rows: PoolRow[]; pools: Record<string, Held> };
const BUDGET_USD = 1_000; // the example's own budget for Basket's quotes, said on the page
const MAX_WANT = 100_000;

export function ExampleView({ data, want, onWant, nowMs }: { data: ExampleData | null | "none"; want: number; onWant: (n: number) => void; nowMs: number }) {
  const legs = data === null || data === "none" ? [] : findLegs(data.pools);
  const n = Number.isFinite(want) ? Math.min(Math.max(Math.floor(want), 0), MAX_WANT) : 0;
  const ok = data !== null && data !== "none" && legs.length > 0;
  // Where the allocator itself would rest today for the example's budget: the contracts the score credits most.
  const quoted = ok ? basketBids(data.settings, data.rows, data.pools, legs, BUDGET_USD) : new Map();
  const chosen = legs.filter((l) => quoted.has(l.symbol)).length;
  const rows = legs.map((leg) => ({ leg, c: cover(leg, n), add: ok ? leastBid(data.settings, leg) ?? undefined : undefined }));
  const filled = rows.reduce((a, r) => a + Math.floor(r.c.filled), 0);
  const cost = rows.reduce((a, r) => a + r.c.costMicros, 0);
  const added = rows.reduce((a, r) => a + (r.add?.qty ?? 0), 0);
  const resting = rows.reduce((a, r) => a + Math.floor(r.c.resting), 0);
  const oldestMin = legs.length === 0 ? 0 : Math.max(0, Math.round((nowMs - Math.min(...legs.map((l) => l.atMs))) / 60_000));

  return (
    <section id="example" className="site-section" aria-labelledby="example-h">
      <h2 id="example-h" className="site-h">An example: a sports bar in Buffalo</h2>
      <p className="site-say">
        The bar has a slow winter when the team falls short. Contracts that pay out if Buffalo misses would offset
        that, and they are in pools Basket already reads on Gemini. The question is how many are resting on the
        book to take, and what a Basket bid would add.
      </p>
      {legs.length === 0 ? (
        <p className="site-quiet" role="status">{data === null ? "Reading the books for this example…" : "The live books for this example are not held by Basket’s server right now. It appears here once they are read."}</p>
      ) : (
        <>
          <label className="plan-budget ex-want">
            <span className="plan-label">Contracts the bar wants of each</span>
            <span className="plan-money"><input type="number" inputMode="numeric" min={0} step={100} max={MAX_WANT} value={want} onChange={(e) => onWant(Number(e.target.value))} /></span>
          </label>
          <dl className="plan-stats ex-stats">
            <div className="plan-stat plan-stat-main"><dt>A Basket bid on each adds</dt><dd>{"+" + count(Math.floor(added))} <span>contracts to take</span></dd></div>
            <div className="plan-stat"><dt>On the book now</dt><dd>{count(Math.floor(resting))} <span>{"across " + rows.length + " contracts"}</span></dd></div>
            <div className="plan-stat"><dt>The bar can take</dt><dd>{count(Math.floor(filled))} <span>{"of " + count(n * rows.length) + " wanted"}</span></dd></div>
            <div className="plan-stat"><dt>Cost of those</dt><dd>{"$" + dollars(cost)}</dd></div>
          </dl>
          <div className="alloc-table-scroll">
            <table className="alloc-pools ex-table">
              <thead>
                <tr>
                  <th scope="col">pays $1 a contract if</th>
                  <th scope="col">price now</th>
                  <th scope="col">resting to take</th>
                  <th scope="col">the bar gets</th>
                  <th scope="col">a Basket bid adds</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ leg, c, add }) => (
                  <tr key={leg.symbol} data-leg="">
                    <th scope="row" className="alloc-pool-name">{leg.paysIf}</th>
                    <td className="alloc-num">{c.priceCents === null ? "no bid" : c.priceCents + "¢"}</td>
                    <td className="alloc-num">{count(Math.floor(c.resting))}</td>
                    <td className="alloc-num">{count(Math.floor(c.filled)) + " for $" + dollars(c.costMicros)}</td>
                    <td className="alloc-num ex-add">{add === undefined ? "—" : "+" + count(add.qty) + " at " + (100 - add.cents) + "¢"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="site-quiet ex-note" role="note">
            {"Gemini’s public books, read by Basket’s server " + (oldestMin < 1 ? "under a minute" : oldestMin + " min") + " ago. The side that pays if Buffalo falls short is priced as a dollar less each resting bid; Gemini’s trading and margin rules were not read. A Basket bid is one pair at the least size Gemini’s program scores, resting at the best prices, or inside the widest spread the program scores where the book is wider. For a $" + count(BUDGET_USD) + " budget the allocator would rest in " + chosen + " of these " + rows.length + " today, where the score credits it most; the last column is what a bid in every one would add. A calculation: nothing is ordered."}
          </p>
        </>
      )}
    </section>
  );
}

/** Reads Basket's server once and every five minutes; with no answer the example says so. */
export function Example() {
  const [data, setData] = useState<ExampleData | null | "none">(null);
  const [want, setWant] = useState(500);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const [a, b] = await Promise.all([fetch("/feed/screen"), fetch("/feed/pools")]);
        if (!a.ok || !b.ok) throw new Error("no answer");
        const screen = (await a.json()) as { settings: Settings; pools: { rows: PoolRow[] } };
        const held = (await b.json()) as { pools?: Record<string, Held> };
        if (!live) return;
        if (held.pools === undefined || screen.pools?.rows === undefined) throw new Error("not the shared reader");
        setData({ settings: screen.settings, rows: screen.pools.rows, pools: held.pools });
        setNowMs(Date.now());
      } catch {
        if (live) setData((d) => (d === null ? "none" : d));
      }
    };
    void load();
    const t = setInterval(() => void load(), 5 * 60_000);
    const tick = setInterval(() => setNowMs(Date.now()), 30_000); // the age of the books keeps counting between reads
    return () => { live = false; clearInterval(t); clearInterval(tick); };
  }, []);
  return <ExampleView data={data} want={want} onWant={setWant} nowMs={nowMs} />;
}
