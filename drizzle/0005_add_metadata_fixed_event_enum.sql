-- Adds `metadata_fixed` to the `book_events.event_type` enum.
--
-- SQLite + Drizzle text-enum columns are enforced at the TypeScript layer
-- only — the original CREATE TABLE emits `event_type text NOT NULL` without
-- a CHECK constraint, so adding an enum value requires no DDL. This file
-- documents the enum delta and keeps the journal/snapshot pair in lockstep
-- with the schema so future migrations remain consistent.
SELECT 1;
