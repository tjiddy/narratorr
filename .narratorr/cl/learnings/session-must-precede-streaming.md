---
scope: [backend]
files: [src/server/routes/search-stream.ts, src/server/services/search-session.ts]
issue: 298
date: 2026-04-02
---
When creating an in-memory session with per-indexer AbortControllers, the session MUST be populated with the real indexer list BEFORE passing controllers to the streaming method. Creating a session with an empty list then having the streaming method query the DB independently results in an empty controllers map — cancellation silently does nothing. Query the indexer list first, create the session, then pass both to the streaming method.
