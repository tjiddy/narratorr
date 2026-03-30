---
scope: [backend]
files: [src/server/utils/download-path.ts, src/server/services/import.service.ts]
issue: 229
source: review
date: 2026-03-30
---
The AC explicitly required `originalPath` in the resolved-save-path log, but it was dropped during implementation when `download.savePath` was found to not exist on the schema. Instead of finding the correct source (the pre-mapping path computed inside `resolveSavePath`), the field was simply omitted. When an AC field doesn't map to an obvious schema column, check the function that computes the value — it may need to return additional data rather than having the field dropped.
