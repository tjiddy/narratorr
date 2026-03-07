export interface ProwlarrConfig {
  url: string;
  apiKey: string;
  syncMode: 'addOnly' | 'fullSync';
  categories: number[];
}

export interface ProwlarrIndexer {
  id: number;
  name: string;
  protocol: 'torrent' | 'usenet';
  fields: ProwlarrField[];
  capabilities?: {
    categories?: ProwlarrCategory[] | null;
  } | null;
  enable: boolean;
}

export interface ProwlarrField {
  name: string;
  value: unknown;
}

export interface ProwlarrCategory {
  id: number;
  name: string;
  subCategories?: ProwlarrCategory[];
}

export interface ProwlarrProxyIndexer {
  prowlarrId: number;
  name: string;
  type: 'torznab' | 'newznab';
  apiUrl: string;
  apiKey: string;
}
