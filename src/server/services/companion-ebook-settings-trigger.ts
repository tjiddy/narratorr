import type { FastifyBaseLogger } from 'fastify';
import type { AppSettings, UpdateSettingsInput } from '@shared/schemas.js';
import type { SettingsService } from './settings.service.js';
import { serializeError } from '../utils/serialize-error.js';

/**
 * The persisted-BEFORE values `PUT /api/settings` needs to decide whether the update earned a
 * companion sweep (#1960 AC25–AC25d).
 *
 * A field is `undefined` exactly when the request omitted that category. That is not a "read
 * failed" marker — it is the AC's own rule that **a category absent from the request body
 * cannot change, so its arm cannot fire**.
 */
export interface CompanionSettingsSnapshot {
  /** Persisted `library.path` before the update. */
  libraryPath?: string | undefined;
  /** Persisted `companionEpub.enabled` before the update. */
  companionEnabled?: boolean | undefined;
}

/** Just the `get` surface — a route test can stub two reads without a whole service double. */
type SettingsReader = Pick<SettingsService, 'get'>;

/**
 * Read the persisted values for exactly the categories this request carries — the
 * snapshot-before half of the `previousNetwork` pattern the same handler already uses.
 *
 * Deliberately UNGUARDED: if a snapshot read throws, the handler fails before
 * `settingsService.update` runs, nothing is persisted, and no trigger is owed.
 */
export async function snapshotCompanionSettings(
  settings: SettingsReader,
  data: UpdateSettingsInput,
): Promise<CompanionSettingsSnapshot> {
  const snapshot: CompanionSettingsSnapshot = {};
  if (data.library !== undefined) {
    snapshot.libraryPath = (await settings.get('library')).path;
  }
  if (data.companionEpub !== undefined) {
    snapshot.companionEnabled = (await settings.get('companionEpub')).enabled;
  }
  return snapshot;
}

/** The enable arm: a persisted `false → true` transition, and nothing else. */
function enableArmFired(before: boolean | undefined, after: boolean | undefined): boolean {
  return before === false && after === true;
}

/** The root arm: the persisted `library.path` actually changed. */
function rootArmFired(before: string | undefined, after: string | undefined): boolean {
  return before !== undefined && after !== before;
}

/**
 * SUCCESS path (AC25/AC25b/AC25c). Compares the snapshot against the `AppSettings`
 * `SettingsService.update` returns — persisted-before vs persisted-after, never the request
 * payload, because `patch` merges a partial category and a request carrying `companionEpub`
 * WITHOUT an `enabled` key leaves the value unchanged.
 *
 * The two arms are independent and OR-ed into ONE call: enable + root change in one request is
 * one sweep, not two, and disable + root change still fires the root arm.
 */
export function companionSettingsChangeFired(
  snapshot: CompanionSettingsSnapshot,
  after: AppSettings,
): boolean {
  const root = rootArmFired(snapshot.libraryPath, after.library.path);
  const enable = enableArmFired(snapshot.companionEnabled, after.companionEpub.enabled);
  return root || enable;
}

/**
 * FAILURE path (AC25d). `SettingsService.update` writes categories one at a time with no
 * transaction, so a multi-category request can durably persist `library.path` or
 * `companionEpub.enabled` and then reject on a LATER category. This re-reads the persisted
 * values so that half is not lost.
 *
 * **The two arms are read separately** — never one `getAll()`, never one `Promise.all`, never
 * one encompassing `try`. Only the categories the request actually carried are read back, each
 * arm is evaluated on its own result, and a successful comparison is never discarded because
 * the OTHER read failed.
 *
 * **An arm whose value cannot be re-read fires CONSERVATIVELY.** A spurious `reconcileAll()` is
 * idempotent, self-gating, and costs one coalesced sweep; a missed trigger leaves exposure
 * stale with no other mechanism to correct it. The read failure is logged at `warn` and
 * swallowed — the caller still rethrows the ORIGINAL settings error, because a settings failure
 * must never be masked by the diagnostic that follows it.
 */
export async function recoverCompanionSettingsChange(
  settings: SettingsReader,
  snapshot: CompanionSettingsSnapshot,
  log: FastifyBaseLogger,
): Promise<boolean> {
  let fired = false;

  if (snapshot.libraryPath !== undefined) {
    try {
      fired = rootArmFired(snapshot.libraryPath, (await settings.get('library')).path) || fired;
    } catch (error: unknown) {
      log.warn({ error: serializeError(error) }, 'Could not re-read library settings after a failed update — assuming the root changed');
      fired = true;
    }
  }

  if (snapshot.companionEnabled !== undefined) {
    try {
      fired = enableArmFired(snapshot.companionEnabled, (await settings.get('companionEpub')).enabled) || fired;
    } catch (error: unknown) {
      log.warn({ error: serializeError(error) }, 'Could not re-read companion-ebook settings after a failed update — assuming the feature was enabled');
      fired = true;
    }
  }

  return fired;
}
