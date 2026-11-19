import { expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GEMINI_TEXT } from "./words.ts";

// Each phrase is split so this file never holds it whole, since the walk reads this file too.
const banned = [["paid", "nobody"], ["un", "paid"], ["un", "claimed"], ["free", "money"], ["ap", "r"], ["ap", "y"], ["a", "year"]]
  .map((w) => w.join(w[0] === "un" || w[0] === "ap" ? "" : " "));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === "dist" || f === "fonts") return [];
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

test("the words for every reward figure are Gemini's text, not an account", () => {
  expect(GEMINI_TEXT).toBe("by the text of Gemini's rules; not observed in any account");
});

test("no file of web/ holds any of the words a pool's figure may never be said in", () => {
  const root = new URL("..", import.meta.url).pathname;
  for (const f of files(root)) {
    const text = readFileSync(f, "utf8").toLowerCase();
    for (const w of banned) expect(text.includes(w), f + " holds “" + w + "”").toBe(false);
  }
});
