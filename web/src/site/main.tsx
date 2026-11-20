// The one page of the public demo. It tells the product in the order a person would use it and
// puts both working halves on it: step one is the operator's allocator on invented markets
// (`screen/App` fed by `sim/markets`), steps two to four are the vault on Arc's test network
// (`vault/VaultApp` laid out for this page). Nothing here asks an exchange anything.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "../screen/App.tsx";
import { Example } from "./Example.tsx";
import { MissingSettings, readVaultEnv } from "../vault/main.tsx";
import { VaultApp } from "../vault/VaultApp.tsx";
import "../ui/weave.css";
import "../vault/vault.css";
import "./site.css";

const STEPS: { href: string; name: string; says: string }[] = [
  { href: "#plan", name: "Plan a budget", says: "See where the scoring rule would credit a budget most." },
  { href: "#fund", name: "Fund the vault", says: "Deposit test dollars into the contract an operator would draw from." },
  { href: "#rounds", name: "Watch a round", says: "The operator draws, returns the money, and your holding moves." },
  { href: "#safety", name: "The safety net", says: "Miss a deadline and anyone can move its bond to depositors." },
];

export function Site({ env }: { env: ReturnType<typeof readVaultEnv> }) {
  return (
    <div className="site">
      <nav className="site-nav" aria-label="the steps">
        <a className="site-mark" href="#top">BASKET</a>
        <ol className="site-nav-steps">
          <li><a href="#example">Example</a></li>
          {STEPS.map((s, i) => <li key={s.href}><a href={s.href}>{(i + 1) + ". " + s.name}</a></li>)}
        </ol>
      </nav>

      <header id="top" className="site-intro">
        <h1 className="site-title">One budget across every reward pool, with the operator’s own money first in line.</h1>
        <p className="site-lede">
          Gemini pays makers for keeping quotes resting in its prediction markets, and splits each reward pool by a
          score it publishes. Basket works out where a budget would be credited most, and pairs it with a vault an
          operator would draw that budget from, its own bond first in line.
        </p>
        <p className="site-start"><a className="site-go" href="#plan">Start with a budget</a></p>
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
          A working demo you can use. Step 1 runs on Gemini’s live public market data or on invented markets, and
          says which. Steps 2 to 4 use test USDC on Arc’s test network with a stand-in operator. No order is placed
          on any exchange.
        </p>
      </header>

      <Example />

      <section id="plan" className="site-section" aria-labelledby="plan-h">
        <h2 id="plan-h" className="site-h">1. Plan a budget</h2>
        <p className="site-say">
          Type a budget. Basket works out the quotes the published score would credit most across every pool, and
          what they would cost. The credit figures are floors, not forecasts.
        </p>
        <App sim shared vaultHref="#fund" />
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
