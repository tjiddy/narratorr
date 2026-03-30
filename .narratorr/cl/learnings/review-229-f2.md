---
scope: [backend]
files: [src/server/services/download.service.ts]
issue: 229
source: review
date: 2026-03-30
---
The AC required `clientName` but implementation used `clientType` because `sendToClient` only returned `clientType`. The reviewer caught that `clientType` (e.g., "qbittorrent") is not equivalent to `clientName` (e.g., "qBit") when multiple clients of the same type exist. When an AC specifies a field name, use that exact field — if the data isn't available, modify the source function to expose it rather than substituting a similar-sounding field.
