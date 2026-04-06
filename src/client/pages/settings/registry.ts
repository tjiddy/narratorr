import type { ComponentType } from 'react';
import {
  SettingsIcon,
  SearchIcon,
  CompassIcon,
  ServerIcon,
  BellIcon,
  ShieldBanIcon,
  ShieldIcon,
  HardDriveIcon,
  ListIcon,
  ZapIcon,
} from '@/components/icons';
import { GeneralSettings } from './GeneralSettings.js';
import { PostProcessingSettings } from './PostProcessingSettings.js';
import { IndexersSettings } from './IndexersSettings.js';
import { DownloadClientsSettings } from './DownloadClientsSettings.js';
import { SearchSettingsPage } from './SearchSettingsPage.js';
import { NotificationsSettings } from './NotificationsSettings.js';
import { BlacklistSettings } from './BlacklistSettings.js';
import { SecuritySettings } from './SecuritySettings.js';
import { ImportListsSettings } from './ImportListsSettings.js';
import { SystemSettings } from './SystemSettings.js';

export interface SettingsPageEntry {
  /** Route path segment (empty string = index route) */
  path: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  component: ComponentType;
  /** If true, NavLink uses exact match (for the index route) */
  end?: boolean;
}

export const settingsPageRegistry: readonly SettingsPageEntry[] = [
  { path: '', label: 'General', icon: SettingsIcon, component: GeneralSettings, end: true },
  { path: 'post-processing', label: 'Post Processing', icon: ZapIcon, component: PostProcessingSettings },
  { path: 'indexers', label: 'Indexers', icon: SearchIcon, component: IndexersSettings },
  { path: 'download-clients', label: 'Download Clients', icon: ServerIcon, component: DownloadClientsSettings },
  { path: 'search', label: 'Search', icon: CompassIcon, component: SearchSettingsPage },
  { path: 'notifications', label: 'Notifications', icon: BellIcon, component: NotificationsSettings },
  { path: 'blacklist', label: 'Blacklist', icon: ShieldBanIcon, component: BlacklistSettings },
  { path: 'security', label: 'Security', icon: ShieldIcon, component: SecuritySettings },
  { path: 'import-lists', label: 'Import Lists', icon: ListIcon, component: ImportListsSettings },
  { path: 'system', label: 'System', icon: HardDriveIcon, component: SystemSettings },
];
