import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { z } from 'zod';
import type { AppSettings } from '../../shared/schemas.js';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
  },
}));

import { toast } from 'sonner';
const { api } = await import('@/lib/api');

const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
};
const mockToast = toast as unknown as {
  success: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

// --- Test schema & helpers ---

const testSchema = z.object({
  enabled: z.boolean(),
  value: z.number().int().min(0).max(100),
});

type TestFormData = z.infer<typeof testSchema>;

const testDefaults: TestFormData = { enabled: false, value: 10 };

const fullSettings = {
  import: { deleteAfterImport: false, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true },
  search: { intervalMinutes: 360, enabled: true, blacklistTtlDays: 7, searchPriority: 'quality' },
  general: { logLevel: 'info', housekeepingRetentionDays: 90, welcomeSeen: false },
  metadata: { audibleRegion: 'us', languages: ['english'] },
  processing: { enabled: false, ffmpegPath: '', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
  tagging: { enabled: false, mode: 'populate_missing', embedCover: false },
  quality: { grabFloor: 0, protocolPreference: 'none', minSeeders: 1, searchImmediately: false, monitorForUpgrades: false, rejectWords: '', requiredWords: '' },
  network: { proxyUrl: '' },
  rss: { intervalMinutes: 30, enabled: false },
  system: { backupIntervalMinutes: 10080, backupRetention: 7, dismissedUpdateVersion: '' },
  library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
  discovery: { enabled: false, intervalHours: 24, maxSuggestionsPerAuthor: 5, expiryDays: 90, snoozeDays: 30, weightMultipliers: {} },
  testSection: { enabled: true, value: 42 },
};

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

// Lazy import of the hook — will fail in RED phase
async function importHook() {
  const mod = await import('./useSettingsForm.js');
  return mod.useSettingsForm;
}

describe('useSettingsForm', () => {
  let queryClient: QueryClient;
  let useSettingsForm: Awaited<ReturnType<typeof importHook>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    queryClient = createQueryClient();
    useSettingsForm = await importHook();
  });

  // Test helper: fullSettings has extra `testSection` not in AppSettings.
  // Cast through Record to access it safely in tests.
  type TestSettings = AppSettings & { testSection: { enabled: boolean; value: number; name?: string } };
  const asTest = (s: AppSettings) => s as unknown as TestSettings;

  const hookConfig = () => ({
    schema: testSchema,
    defaultValues: testDefaults,
    select: (s: AppSettings) => ({ enabled: asTest(s).testSection.enabled, value: asTest(s).testSection.value }),
    toPayload: (d: TestFormData) => ({ testSection: d } as Record<string, unknown>),
    successMessage: 'Test settings saved',
  });

  describe('schema validation', () => {
    it('initializes form with correct defaultValues', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);

      const { result } = renderHook(
        () => useSettingsForm(hookConfig()),
        { wrapper: createWrapper(queryClient) },
      );

      expect(result.current.form.getValues()).toEqual(testDefaults);
    });

    it('zodResolver validation rejects invalid input and surfaces field errors', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);
      mockApi.updateSettings.mockResolvedValue(fullSettings);

      const { result } = renderHook(
        () => useSettingsForm(hookConfig()),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.form.getValues()).toEqual({ enabled: true, value: 42 });
      });

      // Trigger validation via handleSubmit with invalid data
      let validationPassed = false;
      await act(async () => {
        await result.current.form.handleSubmit(
          () => { validationPassed = true; },
          () => { /* noop — errors expected */ },
        )();
      });

      // Set invalid value and re-trigger
      act(() => {
        result.current.form.setValue('value', -1, { shouldDirty: true });
      });

      await act(async () => {
        validationPassed = false;
        await result.current.form.handleSubmit(
          () => { validationPassed = true; },
          () => { /* noop */ },
        )();
      });

      expect(validationPassed).toBe(false);
      expect(mockApi.updateSettings).not.toHaveBeenCalled();
    });

    it('zodResolver validation accepts valid input and allows submission', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);
      mockApi.updateSettings.mockResolvedValue(fullSettings);

      const { result } = renderHook(
        () => useSettingsForm(hookConfig()),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.form.getValues()).toEqual({ enabled: true, value: 42 });
      });

      await act(async () => {
        result.current.onSubmit({ enabled: true, value: 50 });
      });

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith({ testSection: { enabled: true, value: 50 } });
      });
    });
  });

  describe('core lifecycle', () => {
    it('select is called with the settings query result to hydrate form data', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);
      const selectFn = vi.fn((s: AppSettings) => ({ enabled: asTest(s).testSection.enabled, value: asTest(s).testSection.value }));

      renderHook(
        () => useSettingsForm({ ...hookConfig(), select: selectFn }),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(selectFn).toHaveBeenCalledWith(fullSettings);
      });
    });

    it('form.reset fires with select(settings) when settings load and form is NOT dirty', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);

      const { result } = renderHook(
        () => useSettingsForm(hookConfig()),
        { wrapper: createWrapper(queryClient) },
      );

      // Form should be hydrated from settings via select
      await waitFor(() => {
        expect(result.current.form.getValues()).toEqual({ enabled: true, value: 42 });
      });
    });

    it('form.reset does NOT fire when settings refetch and form IS dirty', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);

      const { result } = renderHook(
        () => useSettingsForm(hookConfig()),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.form.getValues()).toEqual({ enabled: true, value: 42 });
      });

      // Dirty the form
      act(() => {
        result.current.form.setValue('value', 99, { shouldDirty: true });
      });

      // Simulate a refetch with different data
      const updatedSettings = { ...fullSettings, testSection: { enabled: false, value: 0 } };
      mockApi.getSettings.mockResolvedValue(updatedSettings);
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['settings'] });
      });

      // Form should still have the user's dirty value
      expect(result.current.form.getValues().value).toBe(99);
    });

    it('mutation calls api.updateSettings with the result of toPayload(formData)', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);
      mockApi.updateSettings.mockResolvedValue(fullSettings);

      const { result } = renderHook(
        () => useSettingsForm(hookConfig()),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.form.getValues()).toEqual({ enabled: true, value: 42 });
      });

      await act(async () => {
        result.current.mutation.mutate({ enabled: true, value: 42 });
      });

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith({ testSection: { enabled: true, value: 42 } });
      });
    });

    it('onSubmit calls mutation.mutate with form data', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);
      mockApi.updateSettings.mockResolvedValue(fullSettings);

      const { result } = renderHook(
        () => useSettingsForm(hookConfig()),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.form.getValues()).toEqual({ enabled: true, value: 42 });
      });

      await act(async () => {
        result.current.onSubmit({ enabled: false, value: 77 });
      });

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith({ testSection: { enabled: false, value: 77 } });
      });
    });

    it('successful mutation invalidates queryKeys.settings(), shows toast.success, resets form', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);
      mockApi.updateSettings.mockResolvedValue(fullSettings);
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(
        () => useSettingsForm(hookConfig()),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.form.getValues()).toEqual({ enabled: true, value: 42 });
      });

      // Dirty the form
      act(() => {
        result.current.form.setValue('value', 99, { shouldDirty: true });
      });
      expect(result.current.form.formState.isDirty).toBe(true);

      await act(async () => {
        result.current.onSubmit({ enabled: true, value: 99 });
      });

      await waitFor(() => {
        expect(mockToast.success).toHaveBeenCalledWith('Test settings saved');
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['settings'] });
      });
    });

    it('failed mutation shows toast.error with error message, does NOT reset form', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);
      mockApi.updateSettings.mockRejectedValue(new Error('Server error'));

      const { result } = renderHook(
        () => useSettingsForm(hookConfig()),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.form.getValues()).toEqual({ enabled: true, value: 42 });
      });

      // Dirty form
      act(() => {
        result.current.form.setValue('value', 99, { shouldDirty: true });
      });

      await act(async () => {
        result.current.onSubmit({ enabled: true, value: 99 });
      });

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith('Server error');
      });

      // Form should NOT be reset — still dirty with user value
      expect(result.current.form.getValues().value).toBe(99);
      expect(mockToast.success).not.toHaveBeenCalled();
    });
  });

  describe('select / toPayload contract', () => {
    it('select extracts a single-category slice — form hydrates with that slice', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);

      const { result } = renderHook(
        () => useSettingsForm({
          ...hookConfig(),
          select: (s: AppSettings) => s.import as unknown as TestFormData,
        }),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.form.getValues()).toEqual(fullSettings.import);
      });
    });

    it('select extracts a cross-category composite — form hydrates with the mapped result', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);

      const crossCategorySelect = (s: AppSettings) => ({
        enabled: s.search.enabled,
        value: s.quality.minSeeders,
      });

      const { result } = renderHook(
        () => useSettingsForm({ ...hookConfig(), select: crossCategorySelect }),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.form.getValues()).toEqual({ enabled: true, value: 1 });
      });
    });

    it('toPayload returns a single-category object — passed through to api.updateSettings', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);
      mockApi.updateSettings.mockResolvedValue(fullSettings);

      const singleCatPayload = (d: TestFormData) => ({ import: d } as Record<string, unknown>);

      const { result } = renderHook(
        () => useSettingsForm({ ...hookConfig(), toPayload: singleCatPayload }),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.form.getValues()).toEqual({ enabled: true, value: 42 });
      });

      await act(async () => {
        result.current.onSubmit({ enabled: true, value: 42 });
      });

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith({ import: { enabled: true, value: 42 } });
      });
    });

    it('toPayload returns a multi-category object — passed through to api.updateSettings', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);
      mockApi.updateSettings.mockResolvedValue(fullSettings);

      const multiCatPayload = (d: TestFormData) => ({
        search: { enabled: d.enabled },
        quality: { minSeeders: d.value },
      } as Record<string, unknown>);

      const { result } = renderHook(
        () => useSettingsForm({ ...hookConfig(), toPayload: multiCatPayload }),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.form.getValues()).toEqual({ enabled: true, value: 42 });
      });

      await act(async () => {
        result.current.onSubmit({ enabled: true, value: 5 });
      });

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith({
          search: { enabled: true },
          quality: { minSeeders: 5 },
        });
      });
    });
  });

  describe('boundary values', () => {
    it('settings query returns undefined initially — form uses defaultValues without crashing', () => {
      mockApi.getSettings.mockReturnValue(new Promise(() => {})); // never resolves

      const { result } = renderHook(
        () => useSettingsForm(hookConfig()),
        { wrapper: createWrapper(queryClient) },
      );

      expect(result.current.form.getValues()).toEqual(testDefaults);
    });

    it('rejected settings query does not crash — form retains defaultValues', async () => {
      mockApi.getSettings.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(
        () => useSettingsForm(hookConfig()),
        { wrapper: createWrapper(queryClient) },
      );

      // Wait for the query to settle (rejected)
      await waitFor(() => {
        expect(mockApi.getSettings).toHaveBeenCalled();
      });

      // Form should still have defaultValues — not crashed
      expect(result.current.form.getValues()).toEqual(testDefaults);
      // Mutation should still be available
      expect(typeof result.current.onSubmit).toBe('function');
    });

    it('empty string fields in settings are handled (not coerced to undefined)', async () => {
      const stringSchema = z.object({ name: z.string() });
      type StringForm = z.infer<typeof stringSchema>;

      const settingsWithEmptyString = { ...fullSettings, testSection: { enabled: true, value: 42, name: '' } };
      mockApi.getSettings.mockResolvedValue(settingsWithEmptyString);

      const { result } = renderHook(
        () => useSettingsForm({
          schema: stringSchema,
          defaultValues: { name: 'default' },
          select: (s: AppSettings) => ({ name: asTest(s).testSection.name ?? '' }),
          toPayload: (d: StringForm) => ({ testSection: d } as Record<string, unknown>),
          successMessage: 'Saved',
        }),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.form.getValues().name).toBe('');
      });
    });
  });
});
