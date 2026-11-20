# Basket

Basket has two halves. The first is an operator's screen on Gemini Prediction Markets' public API: it rebuilds Gemini's published liquidity-rewards score and works out, for a budget, the quotes that score would credit most, as a floor. The second is `BondedVault`, a contract on Arc's test network that holds depositors' USDC behind an operator's first-loss bond, a draw limit, a deadline and a default anyone can declare.

What it is not: it is not a trading bot. It places no order on any exchange and holds no exchange key. The operator is simulated. All money on chain is test USDC on Arc's test network and has no value, and every round in the demo closes with a simulated result.

- **The demo, one page:** https://basket-ubc.westus.azurecontainer.io/ It is laid out in the order a person would use it. Step 1, plan a budget: the allocator and the pool calculator, on Gemini's live reward pools and books when the page's server has read them, and on invented markets otherwise; a line says which and a button switches. Steps 2 to 4, the vault on Arc's test network: add funds, allow, deposit (no app or wallet needed); watch a round (one opens by itself about every ten minutes and closes about thirty seconds later with a small made-up gain; the vault's round length is five minutes, which is the operator's deadline); and the safety net, the bond and the default anyone may declare. `/vault.html` on the same address is the vault alone, for a phone.
- **Video:** [link to be supplied]

## 1. What it does

Gemini rewards makers each day for keeping two-sided quotes resting in its prediction markets, by a score it publishes. The score is public, but it does not say what a quote would score before it is placed, or where a budget would do the most.

The screen answers that from public data:

- **Every reward pool**, against the clock of Gemini's one-minute snapshots, with the state of its books at the last read.
- **A calculator** for one pool: the quote that qualifies, the money it ties up, the most it can lose, and the least share of the pool it would take against every order resting there.
- **An allocator**: for a budget, the quotes across every pool read that the published score would credit most, at the least.

Running such quotes with other people's money is a trust problem, because the money sits on an exchange the chain cannot see. The vault does not pretend to see it. It limits what the operator can take in one round, puts the operator's own bond in front of the depositors, counts a result only in dollars that come back, and gives every depositor a deadline and a button.

## 2. Run it

Node 26 is required. From the repository's root:

```
npm install
npm test
```

`npm test` runs the script checks, then the workspaces (`packages/*`, `contracts`, `web`), then the engine. The relayer is tested on its own: `npm test --prefix services/relayer`.

**The operator's screen** is the `web` workspace, served by Vite on `127.0.0.1`:

```
BASKET_FEED=live BASKET_READ_UNREAD=1 npm run dev -w web
```

Open the address Vite prints. `BASKET_FEED` chooses where the screen's figures come from:

- `live`: the dev server reads Gemini's public API itself, paced as section 7 says, and keeps every raw answer in a folder outside the repository. This is the one to use from a fresh clone. "Read every pool for the allocator" takes about thirty minutes at that pacing (1,794 seconds for 80 pools when timed from a fresh clone on 2026-11-20).
- `kept`: replays answers a `live` run already kept, asking nothing of Gemini.
- unset: replays the folder of an engine run, read-only.

`BASKET_LIVE_DIR` and `BASKET_FORWARD_DIR` name those folders (defaults under `~/Data/hackathons/vault/`). `BASKET_READ_UNREAD=1` also reads the books of contracts whose listed prices could not be read. No secret is read by the screen.

**The phone page** is `web/vault.html`. Its five settings come from the environment at build time: `VITE_VAULT_CHAIN_ID`, `VITE_VAULT_RPC`, `VITE_VAULT_EXPLORER`, `VITE_VAULT_RELAYER`, `VITE_VAULT_VAULT`. Three more are optional: `VITE_VAULT_SCREEN` (a link to the allocator, for the vault-alone page), `VITE_VAULT_ROUND_EVERY` (about how often a round opens on that deployment, in seconds, so the page can say when the next is due) and `VITE_VAULT_SOURCE` (a link to the source). The page says what the vault is, shows the one next step, and lists the vault's recent rounds from its own events: what the operator drew, what it sent back, and the result for depositors. The public node answers for at most 10,000 blocks of events, so that list is the last hour or so, not the whole history.

```
cd web && npx vite build -c vite.public.config.ts
```

**The one page** is `web/site.html` (`web/src/site`), built by the same command. Its first step is the operator's screen. On the public address it asks the shared reader (`services/screen`) for Gemini's lists and every pool's books; where that has nothing yet it shows invented markets instead, made in the browser by `web/src/sim/markets.ts`: eighteen made-up pools whose books are worked out from the minute alone, so every visitor sees the same markets and they move at each snapshot. On the invented markets it keeps a running tally: at each snapshot the allocator's quotes are credited their least share of that minute. Add `?sim` to the dev server's address to see the invented markets alone.

**The shared reader** is `services/screen`: one server that reads Gemini's public API for every visitor, through the same paced reader as the operator's own screen (1.2 seconds between requests, a minute's stop after a 429, every raw answer kept in a folder outside the repository). A pass over the reward list and every pool takes about thirty minutes; a new one begins no sooner than 75 minutes after the last began, and only if somebody has opened the page in the last six hours. A visitor's request is answered from its memory and never causes a request to Gemini.

With the dev server running, `/states.html?s=open` (also `fresh`, `funded`, `holding`, `missed`, `defaulted`, `busy`, `error`) shows the phone page in each of its states from invented values, with no chain and no relayer.

**The contract** is the `contracts` workspace, built and tested with Hardhat 3 on a local chain:

```
npm test -w contracts
```

## 3. Architecture

- `packages/score`: the reward score, who can qualify from prices and from sizes, the widest qualifying pair, the least share. Pure functions.
- `packages/rule`: the engine's decision, its settings file, and the rule's hash (SHA-256 over the settings text and every source file of the three libraries).
- `packages/ledger`: the rows, the fills and minutes the simulation counts, and the chain that links each row's hash to the one before.
- `services/engine`: the simulated operator. It reads Gemini's public lists and books, runs the decision, writes its ledger and every raw answer to a folder outside the repository, and sends each new chain head to the vault on Arc. It has no order request.
- `services/screen`: the shared reader of the public page's first step (above). It has no order request and no key.
- `services/relayer`: gives the phone its fee money. It hands each phone its test USDC once under limits, part of it to deposit and part to pay fees with, tops the fee part up at most twice, sends `declareDefault` itself, and otherwise only passes on a transaction the phone signed (`approve`, `deposit`, `requestWithdraw`, `claim`), which the phone's own key pays for. It also answers a handed phone's account number and fees. Every other call is refused.
- `web/src/screen`, `web/src/alloc.ts`, `web/src/calc.ts`: the operator's screen. `web/feed` is the dev-server route that reads for it; `web/src/sim` makes the invented markets of the public demo, and `web/src/site` is the one public page.
- `web/src/vault`: the phone page and its in-browser wallet.
- `contracts`: `BondedVault.sol`, the deploy script and the stage tool that opens and closes a round.
- `deploy`: the Dockerfiles, the Azure templates and the terms files.

```
   Gemini public API  (read-only, paced)
           |  lists + books
           v
   services/engine --> packages/rule (decide) --> packages/score
        |   writes its ledger and raw answers outside the repository
        |   sends each new head (a hash) ----------> BondedVault on Arc
        v                                                 ^
   web/feed --> operator's screen                         | signed calls
                (pools, calculator, allocator)            |
                                                          |
   phone's browser wallet --> web/src/vault --> services/relayer
```

## 4. Contracts and addresses (Arc test network)

- Chain id `5042002`, RPC `https://rpc.testnet.arc.io`, explorer `https://explorer.testnet.arc.io`.
- USDC: `0x3600000000000000000000000000000000000000`.
- Multicall3, used by the phone page to read in one call: `0xcA11bde05977b3631167028862bE2a173976CA11`.
- `contracts/contracts/BondedVault.sol`, SHA-256 `184a36fa862e51bf99cea416941a2c9a1d7f16177cf58afe7ff406a5e4570662`. Every deployment below is this source.

| `BondedVault` | Address | Terms |
|---|---|---|
| Main vault: two-day round; the engine commits its reads here | `0x41b72ae9a2e352cbfb77950715606f06f5e4d327` | `deploy/terms-vault.json` |
| Demo vault (`stage6`): five-minute round; the one the phone page opens; a demo round runs on it about every ten minutes | `0xc8435058c05ff654f8091a9f05273e21ab46e928` | `deploy/terms-stage6.json` |
| Spare (`stage5`): one-minute round; bonded and unused (`?vault=stage5` on the phone page) | `0x813570cd78318372eca5e20ae876daa8c319d798` | `deploy/terms-stage5.json` |
| `stage`: one-minute round; the phone page's vault until 2026-11-20, no longer run | `0x1781eaafe2b674056f64a7daee1fb77fd8e85b8b` | `deploy/terms-stage.json` |
| `stage2`: one-minute round; in default since a rehearsal on 2026-11-18, closed for good | `0x7653ac79ed456c76eb445482ebe832b15286bb94` | `deploy/terms-stage2.json` |
| `stage3`: one-minute round; a round was left open past its deadline on 2026-11-19 and a default was declared from the phone page on 2026-11-20, closed for good | `0x6dacabf26d0af405b4603600bc6d622e9d540ffd` | `deploy/terms-stage3.json` |
| `stage4`: one-minute round; a default was declared here from the phone page on 2026-11-19, closed for good | `0x493aa0b9b855fe4b06769e8461ee807c9815d6b0` | `deploy/terms-stage4.json` |

The engine's rule hash, named on chain before its first read: `35e939081fa8e0b4ef01814c6437d1cb9a009c977c57bc390be004488ad86ea8`. `node scripts/rule-hash.mjs` works it out again from this repository.

## 5. Economic design

**Gemini's score, as its rules give it.** At each one-minute snapshot an order scores its size over its distance from the midpoint, raised to a power; the midpoint is the best bid and best ask across all accounts, halved. A maker counts only with a bid and an ask, each of at least a least size, no further apart than a widest spread. A one-sided quote scores nothing. There is no size cap. A day's total under a least amount is not distributed. Contracts in post-only mode and members under a market-maker agreement are shut out. The settings are read from Gemini's API at run time; none is typed into the code.

**Why every figure is a floor.** For a pool, Basket reads every contract's book and sets our quote's score against the most the orders already resting there can be scoring: every resting contract is counted as a rival's score, whoever placed it. That share of the pool is the least the published score would credit at the moment the books were read. It is not a forecast. Other makers can arrive and the share falls. A fill changes everything: the best floors are often large bids at one cent beside a thin ask, and a bid that fills is money in a long shot. And every reward figure is by the text of Gemini's rules; not observed in any account.

**The allocator** is greedy. At each step it spends the next block of the budget where it adds the most floor a dollar: entering a contract at the least size on both sides, or growing one side of a quote it holds. Entering is a lump, so this is a good allocation, not a proven best one. From 40,000 dollars up it spends in larger blocks first so the page stays quick.

**The vault's terms**, as deployed (`deploy/terms-*.json`):

- **Bond.** The operator posts its own USDC before any round. A loss is taken from the bond first and reaches depositors only when the bond is gone.
- **Draw limit.** For one round the operator may take at most one and a half times the bond (`drawBondHalves` 3) and at most half the vault (`drawVaultBps` 5000). So the most it can lose or take in a round is a number on chain before the round starts.
- **Only dollars count.** A round closes when the operator sends USDC back. The result is what came back less what went out. The contract never takes a posted value.
- **Fee on a gain.** The operator keeps 20% of a gain (`gainBps` 2000); the rest raises the share price.
- **Deadline and default.** Two days for the main vault, five minutes for the demo vault, one minute for the other stage vaults. If a round is not closed in time, anyone may declare a default: the whole bond moves to the depositors and the vault takes no new round.
- **Deposit cap.** 100,000 USDC for the main vault and 10,000 for the stage vault. The vault is small on purpose.
- **Plan and reads on chain.** A round names the hash of the operator's plan before it draws, and the engine commits one hash for every read, so the record cannot be rewritten after.
- **Shares** are priced through a virtual share, rounding against whoever is buying or selling, so the first depositor cannot move the price on the second.

## 6. Risk assumptions, and what is not solved

- **Rewards are known only from the text of Gemini's rules.** Nothing has been observed in any account. No order was placed by this entry and no reward was received.
- **Gemini may withhold.** Its rules let it delay, withhold or reverse rewards, including for quoting without a real intent to trade, and it may change or end the program.
- **A floor is not a net.** The screen says nothing of fills. The simulation counts a fill wherever its reads leave a doubt, but it cannot see the takers a real quote would attract.
- **The operator is limited, not removed.** In one round it can take the draw less its bond, and it can send back less than it made. The per-market loss cap is a number in the contract and the same number in the engine's settings (`settings/rule.json`), which is the copy the engine keeps to; the contract cannot enforce it, because it cannot see the exchange.
- **The demo's closing figure is the operator's word.** The contract counts only dollars, but the test USDC sent back stands for a simulated result.
- **Pooled money.** Taking other people's money to trade these contracts raises legal questions, and Gemini's terms have a user trade as principal. This entry takes no outside money, and a real version would need counsel and Gemini's written word first.
- **Custody is not built.** A real version needs the drawn money to sit where the operator can trade it and cannot withdraw it. That, and moving USDC between Arc and an exchange with CCTP, are designs only.
- **The engine needs someone else's price.** It quotes only around a midpoint other accounts keep. It can see that the quote is tended; it cannot see that it is right.
- **Known limits of the build.** The relayer is one process with one key. The phone page's wallet key lives in the browser's storage. Many phones behind one network address can meet the public node's rate limit.

## 7. How Gemini's API is used

Public, read-only requests under `https://api.gemini.com/v1` (`services/engine/src/gemini.ts`): the prediction-markets event list and a single event by its ticker, the liquidity-rewards list and its settings, and a contract's order book.

The pacing is in the code: at least 1.2 seconds between requests; nothing for 60 seconds after a 429; the screen's lists no more often than every five minutes, and only when the page asks. A book side that comes back at the API's depth limit is never taken as a whole side. Every raw answer is kept in a folder outside the repository, never in it, and nothing of Gemini's goes on chain.

The public page's shared reader (`services/screen`) reads the same public endpoints at the same pacing, for all visitors at once. No trading endpoint is called and no key is used. `scripts/no-orders.test.mjs` fails the suite if any source file names an order request or a signed-request header.

## 8. How Arc is used

All of the vault's core is on Arc: the USDC it holds, the shares, the bond, the draw limit, each round's plan hash, one hash for every read of the engine's run, what went out and what came back, and the default. No price and nothing of Gemini's is on chain.

Fees on Arc are paid in USDC. That is why a commit every five minutes is practical, and why a phone needs no second token: the relayer hands the phone a little USDC for fees, and the phone signs and pays for only its own four calls.

**The engine's runs.** There are two, under the same rule hash.

- *The first run* started on 2026-11-16 and moved to Azure on 2026-11-17, committing each read's head to the main vault: 252 commits. On 2026-11-18 Gemini's event list stopped returning the season-long markets its reward list names; the engine made no further pass and was stopped.
- *The second run* started on 2026-11-19T02:04Z with a new, empty ledger. Its reader reads those events one at a time by ticker, afresh at every pass, and keeps events that are not sport out of the ledger. It was started fresh on purpose: carried on from the first run's state, the first pass would have counted every quote left standing two days earlier, on games since played, as filled at the moment of the restart. Because a ledger's chain starts at the rule hash, the head on chain went back to the rule hash at the second run's first commit. The two ledgers are separate records, each checkable against its own commits. As of 2026-11-19T06:08Z the second run has written no quote: the rule quotes only in a pool where the reward list shows no maker for the last scored day, and at every read so far each sport pool on the list showed at least one. Its commits are hashes of its ledger, which so far holds one row for each read and no quote or fill.

In the three hashed libraries (`packages/score`, `packages/rule`, `packages/ledger`) a comment that says "the hub" means the team's own limits on reading Gemini's API; those files are left byte for byte as they were, because a changed comment would change the rule hash.

What the simulation still sets against itself: a standing quote it has no read for at a pass is counted as filled on the worse side, whatever the reason the read is missing.

## 9. Prior art

Reported from our reading during the week; "reported" means we did not confirm it ourselves.

| Project | What it does | What it lacks that Basket has | Status |
|---|---|---|---|
| XO Vaults (XO Market) | Users pool capital into vaults that provide liquidity across prediction markets | No operator bond, draw limit or default; no rebuilt reward score | reported |
| Hyperliquid HLP and user vaults | On-chain pooled vaults that make markets on Hyperliquid's perpetuals | Not a prediction-market rewards program; the vault's value is the operator's to post | reported |
| warproxxx/poly-maker | Open-source market-making bot for Polymarket, on one operator's own wallet | Not pooled: no vault, bond, limit or default | confirmed |
| Azuro | Shared on-chain liquidity under several betting front-ends | A liquidity protocol, not a depositor vault with a first-loss bond | reported |
| Thesis Index | Index vault with shares priced on prediction-market positions | A curated fund; no quoting against a published reward score | reported |

We found no product that puts these together: a published reward score rebuilt as a floor, and a vault where the operator's bond stands in front and the chain counts only dollars.

## 10. Provenance

Built during the hackathon week. Some files began as copies from our other entry of the same week, "On the House", and were adapted; nothing is imported from it: the relayer (`services/relayer`), the in-browser wallet (`web/src/vault/wallet.ts`), the deploy script and Hardhat settings (`contracts/scripts/deploy.ts`, `contracts/hardhat.config.ts`), the key-making script (`scripts/make-keys.mjs`) and parts of the page chrome (`web/src/ui`).

Recorded market data is not in this repository. The books and lists the screen and the engine read are public data, kept by read-only scripts in a folder outside it. Every fixture in the tests is invented and says so in its first line.

AI tools were used to write and review code throughout the week.

## 11. Tests

`npm test` from the root, and `npm test --prefix services/relayer`. Counts as of 2026-11-20:

- `packages/score`, `packages/rule`, `packages/ledger` (`node --test`): 31, 32, 52
- `web` (Vitest): 174
- `contracts` (Hardhat, local chain): 71
- `services/engine` (`node --test`): 107
- `services/relayer` (`node --test`): 61
- `services/screen` (`node --test`): 6
- `scripts/` (`node --test`): 17, among them the check that no source file can place an order

## 12. Credits

Built by two people. [credit line to be supplied]
