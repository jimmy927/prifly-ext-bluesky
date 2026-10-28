/**
 * Every child this extension starts passes `windowsHide: true`. On Windows
 * the prifly host runs without a console, so a console program it starts
 * without it — `git`, `bun`, a shell — opens a terminal window over the
 * reader's screen, one per call: an extension's 60 s `git` poll opened about
 * two dozen on 2026-10-22. A newer host makes `true` the default at run time;
 * an older one does not, so this checks the source too: each spawn names
 * `windowsHide`.
 *
 * `spawn-scan.ts` is a copy of prifly's own scan; a fix to it belongs there.
 */

import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { unhidden } from "./spawn-scan";

const ROOT = join(import.meta.dir, "..");

/** Files allowed a spawn without `windowsHide`, each with why. */
const ALLOWED: Record<string, string> = {};

const SOURCE = /\.(?:ts|tsx|js|mjs)$/;

/** This extension's own source files, relative to its top: no dependencies, no tests. */
async function sources(): Promise<string[]> {
  const names = await readdir(ROOT, { recursive: true });
  return names.filter((name) => {
    const parts = name.split(sep);
    if (parts.some((part) => part === "node_modules" || part.startsWith("."))) return false;
    return SOURCE.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".d.ts");
  });
}

test("every spawn in this extension hides its window on Windows", async () => {
  const offenders: string[] = [];
  for (const name of await sources()) {
    if (name in ALLOWED) continue;
    offenders.push(...unhidden(name, await Bun.file(join(ROOT, name)).text()));
  }
  expect(offenders).toEqual([]);
});

test("the scan sees a spawn without windowsHide, and one with it", () => {
  const without = 'const a = 1;\nBun.spawn(["git", "status"], { stdout: "pipe" });\n';
  const hidden = 'Bun.spawn(["git"], { stdout: "pipe", windowsHide: true });\n';
  expect(unhidden("x.ts", without)).toEqual(["x.ts:2"]);
  expect(unhidden("x.ts", hidden)).toEqual([]);
  const node =
    'import { execFile } from "node:child_process";\nexecFile("git", ["fetch"], done);\n';
  expect(unhidden("y.ts", node)).toEqual(["y.ts:2"]);
  const hiddenNode =
    'import { spawn } from "node:child_process";\nspawn("git", [], { windowsHide: true });\n';
  expect(unhidden("y.ts", hiddenNode)).toEqual([]);
});
