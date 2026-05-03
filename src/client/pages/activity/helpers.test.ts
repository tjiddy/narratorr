import { describe, it, expect } from 'vitest';
import { downloadStatusSchema } from '../../../shared/schemas.js';
import { DOWNLOAD_STATUS_REGISTRY } from '../../../shared/download-status-registry.js';
import { statusConfig } from './helpers.js';

describe('statusConfig (derived from registry)', () => {
  const allStatuses = downloadStatusSchema.options;

  it('has an entry for every download status', () => {
    for (const status of allStatuses) {
      expect(statusConfig[status]).toBeDefined();
    }
  });

  it('each entry has icon component, label, color, bgColor, textColor', () => {
    for (const status of allStatuses) {
      const config = statusConfig[status];
      expect(typeof config!.icon).toBe('function');
      expect(config!.label).toBeTruthy();
      expect(config!.color).toBeTruthy();
      expect(config!.bgColor).toBeTruthy();
      expect(config!.textColor).toBeTruthy();
    }
  });

  it('preserves labels from registry', () => {
    for (const status of allStatuses) {
      expect(statusConfig[status]!.label).toBe(DOWNLOAD_STATUS_REGISTRY[status].label);
    }
  });

  it('maps every registry icon id to the exact expected component', () => {
    // Explicit icon-id → component-name parity map
    const expectedComponentNames: Record<string, string> = {
      'clock': 'ClockIcon',
      'arrow-down': 'ArrowDownIcon',
      'check-circle': 'CheckCircleIcon',
      'package': 'PackageIcon',
      'alert-circle': 'AlertCircleIcon',
      'alert-triangle': 'AlertTriangleIcon',
      'shield': 'ShieldIcon',
      'pause': 'PauseIcon',
    };

    for (const status of allStatuses) {
      const registryIcon = DOWNLOAD_STATUS_REGISTRY[status].icon;
      const config = statusConfig[status];
      const expectedName = expectedComponentNames[registryIcon];
      expect(expectedName, `unknown icon id "${registryIcon}" for status "${status}" — add it to the parity map`).toBeDefined();
      expect(
        config!.icon.name || config!.icon.displayName,
        `status "${status}" icon id "${registryIcon}" should map to ${expectedName}`,
      ).toBe(expectedName);
    }
  });

  it('preserves colors from registry', () => {
    for (const status of allStatuses) {
      expect(statusConfig[status]!.color).toBe(DOWNLOAD_STATUS_REGISTRY[status].color);
      expect(statusConfig[status]!.bgColor).toBe(DOWNLOAD_STATUS_REGISTRY[status].bgColor);
      expect(statusConfig[status]!.textColor).toBe(DOWNLOAD_STATUS_REGISTRY[status].textColor);
    }
  });
});
