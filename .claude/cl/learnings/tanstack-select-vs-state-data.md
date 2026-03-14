---
scope: [frontend]
files: [src/client/pages/activity/useActivity.ts]
issue: 355
date: 2026-03-13
---
TanStack Query's `query.state.data` in `refetchInterval` contains the RAW queryFn result (pre-`select`), not the transformed value. When using `select()` to unwrap an envelope, the `refetchInterval` callback must access the raw envelope shape (`raw.data`), not the unwrapped array. The `data` property returned by `useQuery()` hook IS the selected value, but `query.state.data` is always raw.
