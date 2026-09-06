import { describe, it, expect } from 'vitest';
import { downloadStatusSchema } from '@shared/schemas.js';
import { DOWNLOAD_STATUS_REGISTRY } from '@shared/download-status-registry.js';
import { statusConfig, describeDownloadBook } from './helpers.js';

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

describe('describeDownloadBook', () => {
  it('joins the authors in credit order and appends the series with its position', () => {
    expect(describeDownloadBook({ authors: ['R. A. Salvatore', 'Someone Else'], seriesName: "The Hunter's Blades", seriesPosition: 2 }))
      .toBe("R. A. Salvatore, Someone Else · The Hunter's Blades #2");
  });

  it('keeps a fractional series position as written', () => {
    expect(describeDownloadBook({ authors: ['Jodi Taylor'], seriesName: 'St Mary’s', seriesPosition: 4.5 })).toBe('Jodi Taylor · St Mary’s #4.5');
  });

  it('names the series alone when the book has no position in it', () => {
    expect(describeDownloadBook({ authors: [], seriesName: 'Standalone Anthology', seriesPosition: null })).toBe('Standalone Anthology');
  });

  it('shows only the authors when there is no series', () => {
    expect(describeDownloadBook({ authors: ['Stephen King'], seriesName: null, seriesPosition: null })).toBe('Stephen King');
  });

  it('returns null when neither authors nor series are known, so the card renders no byline', () => {
    expect(describeDownloadBook({ authors: [], seriesName: null, seriesPosition: null })).toBeNull();
    expect(describeDownloadBook({})).toBeNull();
  });
});
