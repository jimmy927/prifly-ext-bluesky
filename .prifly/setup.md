---
setup:
  - test ! -f package.json || bun install --frozen-lockfile
---

A prifly extension started from prifly's `templates/prifly-ext-template`: a bun
project whose `bun.lock` is committed. The install is skipped on a checkout
without `package.json` (the repository's first commit).

Relies on outside the worktree: `bun` on the PATH, and a GitHub ssh key that can
read the private `jimmy927/prifly-extension-api` mirror, which `package.json`
pulls `@prifly/extension-api` from by tag. Tests run with `bun test` and need no
network.
