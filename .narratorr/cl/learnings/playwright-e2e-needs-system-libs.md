---
scope: [infra, testing]
files: [scripts/verify.ts, playwright.config.ts]
issue: 653
date: 2026-04-19
---
`scripts/verify.ts`'s E2E gate depends on `chrome-headless-shell` being both downloaded AND able to link against system shared libs (`libglib-2.0`, `libnss3`, `libX11`, `libatk`, `libdbus`, `libgbm`, etc.). A bare `pnpm exec playwright install chromium` only downloads the binary; you also need `playwright install-deps chromium` which requires root (`sudo`/`apt-get`). If the session has no sudo, the E2E gate fails on every diff — including trivial refactors with zero UI surface — and reproduces identically on `main`. First-time setup on a new sandbox should run `ldd` on the chrome-headless-shell binary to confirm deps resolve before trusting `/implement`'s verify gate. Block on env failure is a wasteful but correct default since the skill can't distinguish env failure from a regression.
