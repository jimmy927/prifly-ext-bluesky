/**
 * Finds the spawn calls in a source file that do not name `windowsHide`. On
 * a Windows host, a console program started without `windowsHide: true` opens
 * a console window of its own (the dictation workers, 2026-10-14; an
 * extension's `git` poll, two dozen terminals a minute, 2026-10-22).
 *
 * `spawn-hidden.test.ts` runs it over the host's code. The extension template
 * carries a byte-for-byte copy (`templates/prifly-ext-template/test/spawn-scan.ts`),
 * since an extension is a repository of its own and cannot import the host;
 * `spawn-hidden.test.ts` fails when the two differ.
 */

/**
 * `Bun.spawn(` anywhere; node's `spawn(`, `execFile(`, `exec(` and `fork(` where
 * `node:child_process` is imported. Synchronous waits are not looked for: prifly's
 * `scripts/no-sync-spawn.test.ts` allows none.
 */
const BUN_SPAWN = /\bBun\.spawn\(/g;
const NODE_SPAWN = /(?<![\w.])(?:spawn|execFile|exec|fork)\(/g;

/** The text between the call's parentheses, from the `(` at `open`. */
function argumentsAt(text: string, open: number): string {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    const char = text[at];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (depth === 0) return text.slice(open, at + 1);
  }
  return text.slice(open);
}

/** `file:line` of each spawn in `text` without `windowsHide`. */
export function unhidden(file: string, text: string): string[] {
  const patterns = text.includes("node:child_process") ? [BUN_SPAWN, NODE_SPAWN] : [BUN_SPAWN];
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const open = match.index + match[0].length - 1;
      if (argumentsAt(text, open).includes("windowsHide")) continue;
      const lineStart = text.lastIndexOf("\n", match.index) + 1;
      // A call named in a comment is no call.
      if (/^\s*(\*|\/\/)/.test(text.slice(lineStart, match.index))) continue;
      const line = text.slice(0, match.index).split("\n").length;
      found.push(`${file}:${line}`);
    }
  }
  return found;
}
