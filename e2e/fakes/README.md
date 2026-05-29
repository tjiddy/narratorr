# e2e/fakes

Fake external-service implementations the harness boots so E2E runs stay hermetic:

- `torrent.ts` — minimal bencode builder + info_hash computer
- `mam.ts` — MyAnonamouse indexer fake (Fastify, :4100)
- `qbit.ts` — qBittorrent WebUI fake (Fastify, :4200)
- `audible.ts` — Audible catalog fake (Fastify, :4300)

Each fake has a `*.test.ts` sibling run under vitest (`pnpm test`).
