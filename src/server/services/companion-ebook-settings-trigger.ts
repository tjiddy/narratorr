import type { FastifyBaseLogger } from 'fastify';
import type { AppSettings, UpdateSettingsInput } from '@shared/schemas.js';
import type { SettingsService } from './settings.service.js';
import { serializeError } from '../utils/serialize-error.js';

/**
 * Persisted values before a settings update. `undefined` means the request omitted that category,
 * never that its read failed.
 */
export interface CompanionSettingsSnapshot {
  libraryPath?: string | undefined;
  companionEnabled?: boolean | undefined;
}

type SettingsReader = Pick<SettingsService, 'get'>;

/** Read only requested categories; a failed snapshot aborts before the update can persist. */
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

function enableArmFired(before: boolean | undefined, after: boolean | undefined): boolean {
  return before === false && after === true;
}

function rootArmFired(before: string | undefined, after: string | undefined): boolean {
  return before !== undefined && after !== before;
}

/** Compare persisted values, not the partial request; either change yields one sweep. */
export function companionSettingsChangeFired(
  snapshot: CompanionSettingsSnapshot,
  after: AppSettings,
): boolean {
  const root = rootArmFired(snapshot.libraryPath, after.library.path);
  const enable = enableArmFired(snapshot.companionEnabled, after.companionEpub.enabled);
  return root || enable;
}

/**
 * Updates are nontransactional, so re-read requested categories independently after failure.
 * A failed re-read conservatively fires; callers still rethrow the original update error.
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
