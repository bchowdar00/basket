// Every value in this file is invented. None is a reading of any market or of any chain.
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { Site } from "./main.tsx";

const ENV = { ok: true as const, settings: { chainId: 31337, rpc: "http://rpc.example", vault: "0x00000000000000000000000000000000000000b2" as const, relayer: "/relay", explorer: "https://explorer.example", sourceUrl: "https://source.example/basket" } };

test("the one page: its name once, the four steps in the bar and in the opening, each pointing at a section that is on the page", () => {
  const html = renderToStaticMarkup(<Site env={ENV} />);
  expect(html.split("<h1").length).toBe(2);
  for (const id of ["plan", "fund"]) expect(html).toContain('id="' + id + '"');
  for (const href of ["#plan", "#fund", "#rounds", "#safety"]) expect(html.split('href="' + href + '"').length).toBeGreaterThanOrEqual(3);
  expect(html.indexOf('id="plan"')).toBeLessThan(html.indexOf('id="fund"'));
  expect(html).toContain("and says which");
  expect(html).toContain("No order is placed on any exchange");
  expect(html).toContain("https://source.example/basket");
});

test("with a setting missing the page still opens and names it", () => {
  const html = renderToStaticMarkup(<Site env={{ ok: false, missing: ["VITE_VAULT_RPC (a value)"] }} />);
  expect(html).toContain("1. Plan a budget");
  expect(html).toContain("VITE_VAULT_RPC");
});
