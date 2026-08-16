import type { SearchResult } from './types.js';
import { NewznabFamilyIndexer, type KeptResultBase } from './newznab-family.js';

export interface NewznabConfig {
  apiUrl: string; // e.g., 'https://nzbgeek.info'
  apiKey: string;
  flareSolverrUrl?: string | undefined;
  proxyUrl?: string | undefined;
}

export class NewznabIndexer extends NewznabFamilyIndexer {
  readonly type = 'newznab';

  protected readonly searchAttrs = 'grabs,language,group,files';
  protected readonly apiErrorPrefix = 'Newznab API error';
  protected readonly attrSelector = 'newznab\\:attr, attr';

  /** An NZB has no synthesizable address, so the shared enclosure/link derivation is the whole rule. */
  protected resolveItemDownloadUrl(directUrl: string | undefined): string | undefined {
    return directUrl;
  }

  protected buildKeptResult(common: KeptResultBase, attrs: Record<string, string>): SearchResult {
    const newsgroup = attrs.group || undefined;

    return {
      ...common,
      protocol: 'usenet',
      ...(newsgroup !== undefined && { newsgroup }),
    };
  }
}
