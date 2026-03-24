import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { PostProcessingSettings } from './PostProcessingSettings';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    probeFfmpeg: vi.fn(),
  },
}));

const { api } = await import('@/lib/api');
const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getSettings.mockResolvedValue(createMockSettings());
});

describe('PostProcessingSettings', () => {
  it('renders the Post Processing section', async () => {
    renderWithProviders(<PostProcessingSettings />);

    await waitFor(() => {
      expect(screen.getByText('Post Processing')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Enable Post Processing')).toBeInTheDocument();
  });

  // Detailed progressive disclosure, form behavior, and payload tests are in
  // ProcessingSettingsSection.test.tsx which covers the underlying component.
});
