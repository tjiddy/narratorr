import { describe, it, expect } from 'vitest';
import { booksApi } from './books.js';
import { searchApi } from './search.js';
import { activityApi } from './activity.js';
import { indexersApi } from './indexers.js';
import { downloadClientsApi } from './download-clients.js';
import { notifiersApi } from './notifiers.js';
import { blacklistApi } from './blacklist.js';
import { settingsApi } from './settings.js';
import { libraryScanApi } from './library-scan.js';
import { prowlarrApi } from './prowlarr.js';
import { systemApi } from './system.js';
import { authApi } from './auth.js';
import { filesystemApi } from './filesystem.js';
import { remotePathMappingsApi } from './remote-path-mappings.js';
import { eventHistoryApi } from './event-history.js';

const allModules = [
  { name: 'booksApi', api: booksApi },
  { name: 'searchApi', api: searchApi },
  { name: 'activityApi', api: activityApi },
  { name: 'indexersApi', api: indexersApi },
  { name: 'downloadClientsApi', api: downloadClientsApi },
  { name: 'notifiersApi', api: notifiersApi },
  { name: 'blacklistApi', api: blacklistApi },
  { name: 'settingsApi', api: settingsApi },
  { name: 'libraryScanApi', api: libraryScanApi },
  { name: 'prowlarrApi', api: prowlarrApi },
  { name: 'systemApi', api: systemApi },
  { name: 'authApi', api: authApi },
  { name: 'filesystemApi', api: filesystemApi },
  { name: 'remotePathMappingsApi', api: remotePathMappingsApi },
  { name: 'eventHistoryApi', api: eventHistoryApi },
];

describe('API barrel export collision detection', () => {
  it('no two API modules export the same method name', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];

    for (const { name, api } of allModules) {
      for (const key of Object.keys(api)) {
        if (seen.has(key)) {
          collisions.push(`"${key}" exported by both ${seen.get(key)} and ${name}`);
        } else {
          seen.set(key, name);
        }
      }
    }

    expect(collisions, `API method name collisions found:\n${collisions.join('\n')}`).toEqual([]);
  });
});
