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
import "./restyle.css";
import meshUrl from "./assets/mesh.svg";

// A step's name in the bar and on its section, and what the opening says it is for.
const STEPS: { href: string; name: string; does: string; says: string }[] = [
  { href: "#plan", name: "Plan a budget", does: "Find the gaps", says: "Put a budget where the exchange’s published score credits a two-sided quote most: the thin markets." },
  { href: "#fund", name: "Fund the vault", does: "Fund them safely", says: "Depositors back an operator through a contract that caps every draw." },
  { href: "#rounds", name: "Watch a round", does: "Keep it checkable", says: "Every plan’s hash goes on chain with its draw, so the record cannot be rewritten." },
  { href: "#safety", name: "The safety net", does: "Put the bond first", says: "The operator’s own bond takes a loss first, and anyone can enforce the deadline." },
];

export function Site({ env }: { env: ReturnType<typeof readVaultEnv> }) {
  return (
    <div className="site">
      <nav className="site-nav" aria-label="the steps">
        <a className="site-mark" href="#top">Basket</a>
        <ol className="site-nav-steps">
          <li><a href="#example">Example</a></li>
          {STEPS.map((s) => <li key={s.href}><a href={s.href}>{s.name}</a></li>)}
        </ol>
      </nav>

      <header id="top" className="site-intro">
        <div className="mesh" aria-hidden="true"><img className="mesh-drift" src={meshUrl} alt="" /></div>
        <ul className="mesh-legend" aria-label="what the woven lines stand for">
          <li>Each strand, a market where depth is thin</li>
          <li>Woven across them, one budget placed where depth pays</li>
          <li>Underneath, the operator’s own bond</li>
        </ul>
        <div className="site-intro-copy">
          <h1 className="site-title"><span>A liquidity engine for</span> <span>thin prediction markets.</span></h1>
          <p className="site-lede">
            Prediction markets are deep in a few headline markets and thin almost everywhere else, Gemini included.
            Basket is built to put depth there.
          </p>
          <p className="site-start"><a className="site-go" href="#plan">Start with a budget</a></p>
        </div>
        <ol className="site-steps">
          {STEPS.map((s, i) => (
            <li key={s.href}>
              <a href={s.href} aria-label={(i + 1) + ". " + s.name + ": " + s.does}>
                <span className="site-step-n">{i + 1}</span>
                <span className="site-step-name">{s.does}</span>
                <span className="site-step-says">{s.says}</span>
              </a>
            </li>
          ))}
        </ol>
        <p className="site-note" role="note">
          Live on Gemini’s public data, or invented markets, and says which. The vault runs on Arc’s test network
          with test USDC and a stand-in operator. No order is placed on any exchange.
        </p>
      </header>

      <Example />

      <section id="plan" className="site-section" aria-labelledby="plan-h">
        <h2 id="plan-h" className="site-h">1. Plan a budget</h2>
        <p className="site-say">
          Type a budget. From the books and reward pools shown here, Basket picks the quotes the published score
          would credit most, and shows what they would tie up and the most they could lose. The credit figures are
          floors at those books, not forecasts.
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
