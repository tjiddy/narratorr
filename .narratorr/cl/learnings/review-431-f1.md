---
scope: [frontend]
files: [src/client/hooks/useEventSource.ts]
issue: 431
source: review
date: 2026-04-08
---
The TOAST_EVENT_CONFIG drives toasts for all events of a given type, but cancellation reuses merge_failed with a typed reason field. The toast layer fires before the merge store handler, so it doesn't know about the reason. When adding a typed discriminator to an existing event, check all consumers — not just the store handler, but also the toast layer, cache invalidation rules, and any other data-driven dispatchers.
