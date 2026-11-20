// The one page of the public demo. It tells the product in the order a person would use it and
// puts both working halves on it: step one is the operator's allocator on invented markets
// (`screen/App` fed by `sim/markets`), steps two to four are the vault on Arc's test network
// (`vault/VaultApp` laid out for this page). Nothing here asks an exchange anything.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "../screen/App.tsx";
import { MissingSettings, readVaultEnv } from "../vault/main.tsx";
import { VaultApp } from "../vault/VaultApp.tsx";
import "../ui/weave.css";
import "../vault/vault.css";
import "./site.css";

const STEPS: { href: string; name: string; says: string }[] = [
  { href: "#plan", name: "Plan a budget", says: "Type a budget and see the quotes the scoring rule would credit most, across every pool." },
  { href: "#fund", name: "Fund the vault", says: "Deposit test dollars into the contract an operator would draw that budget from." },
  { href: "#rounds", name: "Watch a round", says: "The operator draws, sends the money back, and what you hold moves." },
  { href: "#safety", name: "The safety net", says: "If it misses its deadline, anyone can move its bond to depositors." },
];

export function Site({ env }: { env: ReturnType<typeof readVaultEnv> }) {
  return (
    <div className="site">
      <nav className="site-nav" aria-label="the steps">
        <a className="site-mark" href="#top">BASKET</a>
        <ol className="site-nav-steps">
          {STEPS.map((s, i) => <li key={s.href}><a href={s.href}>{(i + 1) + ". " + s.name}</a></li>)}
        </ol>
      </nav>

      <header id="top" className="site-intro">
        <h1 className="site-title">One budget across every reward pool, with the operator’s own money first in line.</h1>
        <p className="site-lede">
          Gemini pays makers every day for keeping two-sided quotes resting in its prediction markets, and splits each
          reward pool by a score it publishes. Basket is two things built on that. An allocator works out where a
          budget would be credited most. A bonded vault is where an operator would get that budget, under limits it
          cannot get round.
        </p>
        <ol className="site-steps">
          {STEPS.map((s, i) => (
            <li key={s.href}>
              <a href={s.href}>
                <span className="site-step-n">{i + 1}</span>
                <span className="site-step-name">{s.name}</span>
                <span className="site-step-says">{s.says}</span>
              </a>
            </li>
          ))}
        </ol>
        <p className="site-note" role="note">
          This is a working demo, and everything on it can be used. The markets in step 1 are invented. The money in
          steps 2 to 4 is test USDC on Arc’s test network. No order is placed on any exchange.
        </p>
      </header>

      <section id="plan" className="site-section" aria-labelledby="plan-h">
        <h2 id="plan-h" className="site-h">1. Plan a budget</h2>
        <p className="site-say">
          Every minute a snapshot is taken, and each pool’s reward for that minute is split by the score: size, over
          the distance from the middle of the book, squared. So for any budget the best quotes can be worked out
          before a cent is committed. Change the budget, switch the stance, or open a pool in the table to try your
          own size and spread. Each figure is a floor: it counts every order already resting as a rival. The markets
          here are invented and move at every snapshot, so there is always something to try; the scoring is the real rule.
        </p>
        <App sim vaultHref="#fund" />
      </section>

      {env.ok ? <VaultApp settings={env.settings} site /> : <MissingSettings missing={env.missing} />}

      {env.ok && env.settings.sourceUrl !== undefined && (
        <footer className="site-end">
          <a href={env.settings.sourceUrl} target="_blank" rel="noreferrer">Source, architecture and the economic design</a>
        </footer>
      )}
    </div>
  );
}

const container = typeof document !== "undefined" ? document.getElementById("site-root") : null;
if (container !== null) {
  createRoot(container).render(<StrictMode><Site env={readVaultEnv(import.meta.env as unknown as Record<string, unknown>)} /></StrictMode>);
}
