import type { SearchResult } from './types.js';
import { buildMagnetUri } from '../utils/magnet.js';
import { parseOptionalNumber } from './parse-attr.js';
import { NewznabFamilyIndexer, type KeptResultBase } from './newznab-family.js';

export interface TorznabConfig {
  apiUrl: string; // e.g., 'https://jackett.example.com/api/v2.0/indexers/mytracker/results/torznab'
  apiKey: string;
  flareSolverrUrl?: string | undefined;
  proxyUrl?: string | undefined;
}

export class TorznabIndexer extends NewznabFamilyIndexer {
  readonly type = 'torznab';

  protected readonly searchAttrs = 'grabs,language';
  protected readonly apiErrorPrefix = 'Torznab API error';
  protected readonly attrSelector = 'newznab\\:attr, torznab\\:attr, attr';

  /** A torrent is addressable from its infohash alone, so a hashed item without a URL still grabs. */
  protected resolveItemDownloadUrl(
    directUrl: string | undefined,
    title: string,
    attrs: Record<string, string>,
  ): string | undefined {
    if (directUrl) return directUrl;
    return attrs.infohash ? buildMagnetUri(attrs.infohash, title) : undefined;
  }

  protected buildKeptResult(common: KeptResultBase, attrs: Record<string, string>): SearchResult {
    const infoHash = attrs.infohash || undefined;
    const seeders = parseOptionalNumber(attrs.seeders);
    const leechers = parseOptionalNumber(attrs.leechers);

    return {
      ...common,
      protocol: 'torrent',
      ...(infoHash !== undefined && { infoHash }),
      ...(seeders !== undefined && { seeders }),
      ...(leechers !== undefined && { leechers }),
    };
  }
}
