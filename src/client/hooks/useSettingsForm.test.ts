import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { z } from 'zod';
import type { AppSettings } from '../../shared/schemas.js';
import { useDirtyFormsState, _resetForTesting } from './dirty-forms.js';

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
  processing: { ffmpegPath: '', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 1, postProcessingScript: '', postProcessingScriptTimeout: 300 },
  tagging: { enabled: false, mode: 'populate_missing', embedCover: false },
  quality: { grabFloor: 0, protocolPreference: 'none', minSeeders: 1, searchImmediately: false, rejectWords: '', requiredWords: '' },
  network: { proxyUrl: '' },
  rss: { intervalMinutes: 30, enabled: false },
  system: { backupIntervalMinutes: 10080, backupRetention: 7 },
  library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
  discovery: { enabled: false, intervalHours: 24, maxSuggestionsPerAuthor: 5, expiryDays: 90 },
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
    label: 'Test Section',
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
          label: 'Test Section',
        }),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.form.getValues().name).toBe('');
      });
    });
  });

  describe('dirty-form guard registration', () => {
    beforeEach(() => {
      _resetForTesting();
    });

    // Probe both the form and the derived registry snapshot from one render.
    function useFormWithProbe<T extends Record<string, unknown>>(config: Parameters<typeof useSettingsForm<T>>[0]) {
      const form = useSettingsForm(config);
      const state = useDirtyFormsState();
      return { form, state };
    }

    it('registers the configured label when the form is dirtied and clears on save success', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);
      mockApi.updateSettings.mockResolvedValue(fullSettings);

      const { result } = renderHook(
        () => useFormWithProbe({ ...hookConfig(), label: 'Merge & Convert' }),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.form.form.getValues()).toEqual({ enabled: true, value: 42 });
      });
      // Clean form → not in the dirty list.
      expect(result.current.state.dirtyLabels).toEqual([]);

      act(() => {
        result.current.form.form.setValue('value', 99, { shouldDirty: true });
      });
      expect(result.current.state.dirtyLabels).toEqual(['Merge & Convert']);

      // A successful save resets the form → registration becomes clean.
      await act(async () => {
        result.current.form.mutation.mutate({ enabled: true, value: 99 });
      });
      await waitFor(() => {
        expect(result.current.state.dirtyLabels).toEqual([]);
      });
    });

    it('reports anyPending while a save is in flight', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);
      let resolveSave: (v: unknown) => void = () => {};
      mockApi.updateSettings.mockReturnValue(new Promise((r) => { resolveSave = r; }));

      const { result } = renderHook(
        () => useFormWithProbe({ ...hookConfig(), label: 'Network' }),
        { wrapper: createWrapper(queryClient) },
      );
      await waitFor(() => {
        expect(result.current.form.form.getValues()).toEqual({ enabled: true, value: 42 });
      });

      act(() => {
        result.current.form.mutation.mutate({ enabled: true, value: 42 });
      });
      await waitFor(() => {
        expect(result.current.state.anyPending).toBe(true);
      });

      await act(async () => {
        resolveSave(fullSettings);
      });
      await waitFor(() => {
        expect(result.current.state.anyPending).toBe(false);
      });
    });

    it('keeps the label dirty when a save fails', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);
      mockApi.updateSettings.mockRejectedValue(new Error('boom'));

      const { result } = renderHook(
        () => useFormWithProbe({ ...hookConfig(), label: 'Quality' }),
        { wrapper: createWrapper(queryClient) },
      );
      await waitFor(() => {
        expect(result.current.form.form.getValues()).toEqual({ enabled: true, value: 42 });
      });

      act(() => {
        result.current.form.form.setValue('value', 5, { shouldDirty: true });
      });
      await act(async () => {
        result.current.form.mutation.mutate({ enabled: true, value: 5 });
      });
      // Failed save → dirty persists.
      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalled();
      });
      expect(result.current.state.dirtyLabels).toEqual(['Quality']);
    });

    it('registers distinct labels for two forms sharing a successMessage', () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);

      function useTwoCards() {
        const housekeeping = useSettingsForm({ ...hookConfig(), successMessage: 'General settings saved', label: 'Housekeeping' });
        const logging = useSettingsForm({ ...hookConfig(), successMessage: 'General settings saved', label: 'Logging' });
        return { housekeeping, logging, state: useDirtyFormsState() };
      }

      const { result } = renderHook(() => useTwoCards(), { wrapper: createWrapper(queryClient) });
      expect(result.current.state.dirtyLabels).toEqual([]);

      // Dirty both → both labels present, proving labels come from config, not the
      // shared toast text.
      act(() => {
        result.current.housekeeping.form.setValue('value', 1, { shouldDirty: true });
        result.current.logging.form.setValue('value', 2, { shouldDirty: true });
      });
      expect(result.current.state.dirtyLabels).toEqual(['Housekeeping', 'Logging']);
    });
  });

  describe('in-flight edit race (success-reset clobber)', () => {
    beforeEach(() => {
      _resetForTesting();
    });

    // Same probe as the guard-registration block, redeclared here so this describe is
    // self-contained (both subscribe isDirty during render via useDirtyFormsState).
    function useFormWithProbe<T extends Record<string, unknown>>(config: Parameters<typeof useSettingsForm<T>>[0]) {
      const form = useSettingsForm(config);
      const state = useDirtyFormsState();
      return { form, state };
    }

    // A controllable deferred save: returns a { resolve } handle the test fires after
    // making (or not making) an in-flight edit, mirroring the real click→response gap.
    function deferSave() {
      let resolve: (v: unknown) => void = () => {};
      mockApi.updateSettings.mockReturnValue(new Promise((r) => { resolve = r; }));
      return { resolve: (v: unknown) => resolve(v) };
    }

    // Transforming schema mirroring networkFormSchema's proxyUrl (trim + strip trailing
    // slashes). Input === output === string, so it satisfies z.ZodType<T, T>.
    const transformSchema = z.object({
      url: z.string().transform((s) => s.trim().replace(/\/+$/, '')),
    });
    type TransformForm = { url: string };
    const transformConfig = (label = 'Network'): Parameters<typeof useSettingsForm<TransformForm>>[0] => ({
      schema: transformSchema as unknown as z.ZodType<TransformForm, TransformForm>,
      defaultValues: { url: '' },
      select: () => ({ url: '' }),
      toPayload: (d: TransformForm) => ({ network: { proxyUrl: d.url } } as Record<string, unknown>),
      successMessage: 'Network settings saved',
      label,
    });

    it('preserves a forward in-flight edit (V1→V2, state 3): draft kept, form dirty', async () => {
      // Never-resolving settings query isolates onSuccess from hydrate/refetch.
      mockApi.getSettings.mockReturnValue(new Promise(() => {}));
      const save = deferSave();

      const { result } = renderHook(
        () => useFormWithProbe({ ...hookConfig(), label: 'Test Section' }),
        { wrapper: createWrapper(queryClient) },
      );

      // Dirty to the submit value V1, then submit it.
      act(() => {
        result.current.form.form.setValue('value', 99, { shouldDirty: true });
      });
      act(() => {
        result.current.form.mutation.mutate({ enabled: true, value: 99 });
      });

      // Edit again while the save is in flight (V1→V2).
      act(() => {
        result.current.form.form.setValue('value', 123, { shouldDirty: true });
      });

      await act(async () => {
        save.resolve(fullSettings);
      });

      // The newer value survives and the card stays dirty.
      expect(result.current.form.form.getValues().value).toBe(123);
      await waitFor(() => {
        expect(result.current.state.dirtyLabels).toEqual(['Test Section']);
      });
    });

    it('preserves a revert-to-baseline in-flight edit (V1→V0, state 3): draft kept, form dirty', async () => {
      mockApi.getSettings.mockReturnValue(new Promise(() => {}));
      const save = deferSave();

      const { result } = renderHook(
        () => useFormWithProbe({ ...hookConfig(), label: 'Test Section' }),
        { wrapper: createWrapper(queryClient) },
      );

      // Baseline V0 = the default (10). Edit to V1 = 99 and submit.
      act(() => {
        result.current.form.form.setValue('value', 99, { shouldDirty: true });
      });
      act(() => {
        result.current.form.mutation.mutate({ enabled: false, value: 99 });
      });

      // Revert back to the pre-submit baseline V0 while the save is in flight.
      act(() => {
        result.current.form.form.setValue('value', 10, { shouldDirty: true });
      });

      await act(async () => {
        save.resolve(fullSettings);
      });

      // The reverted value (V0=10) is retained — NOT overwritten with the saved V1=99 —
      // and the form is dirty relative to the saved value. This is the case keepDirtyValues
      // would fail (reverting to the old default clears RHF's dirty flag).
      expect(result.current.form.form.getValues().value).toBe(10);
      await waitFor(() => {
        expect(result.current.state.dirtyLabels).toEqual(['Test Section']);
      });
    });

    it('does not alias a nested-object snapshot (deep clone): nested in-flight edit kept, dirty', async () => {
      mockApi.getSettings.mockReturnValue(new Promise(() => {}));
      const save = deferSave();

      const nestedSchema = z.object({ group: z.object({ value: z.string() }) });
      type NestedForm = { group: { value: string } };

      const { result } = renderHook(
        () => useFormWithProbe<NestedForm>({
          schema: nestedSchema as unknown as z.ZodType<NestedForm, NestedForm>,
          defaultValues: { group: { value: 'a' } },
          select: () => ({ group: { value: 'a' } }),
          toPayload: (d: NestedForm) => ({ testSection: d } as Record<string, unknown>),
          successMessage: 'Saved',
          label: 'Nested',
        }),
        { wrapper: createWrapper(queryClient) },
      );

      // Submit the current (default) value, then mutate a NESTED path while in flight.
      act(() => {
        result.current.form.mutation.mutate({ group: { value: 'a' } });
      });
      act(() => {
        result.current.form.form.setValue('group.value', 'edited', { shouldDirty: true });
      });

      await act(async () => {
        save.resolve(fullSettings);
      });

      // Only holds if the onMutate snapshot deep-cloned the nested object; a shallow copy
      // would have been mutated in place by the setValue and read as "no drift".
      expect(result.current.form.form.getValues().group.value).toBe('edited');
      await waitFor(() => {
        expect(result.current.state.dirtyLabels).toEqual(['Nested']);
      });
    });

    it('transforming schema, no in-flight edit (state 1): settles clean and shows normalized value', async () => {
      mockApi.getSettings.mockReturnValue(new Promise(() => {}));
      const save = deferSave();

      const { result } = renderHook(
        () => useFormWithProbe(transformConfig('Network')),
        { wrapper: createWrapper(queryClient) },
      );

      // Raw text with surrounding space + trailing slash; the resolver normalizes it.
      act(() => {
        result.current.form.form.setValue('url', ' http://x/ ', { shouldDirty: true });
      });

      // Real submit path so submittedData is the resolver-parsed value while getValues() stays raw.
      await act(async () => {
        await result.current.form.form.handleSubmit(result.current.form.onSubmit)();
      });
      // No in-flight edit made.
      await act(async () => {
        save.resolve(fullSettings);
      });

      // No false drift: clean, and the normalized value is displayed.
      await waitFor(() => {
        expect(result.current.state.dirtyLabels).toEqual([]);
      });
      expect(result.current.form.form.getValues('url')).toBe('http://x');
    });

    it('transforming schema, in-flight edit to a DIFFERENT value (state 3): raw draft kept, dirty', async () => {
      mockApi.getSettings.mockReturnValue(new Promise(() => {}));
      const save = deferSave();

      const { result } = renderHook(
        () => useFormWithProbe(transformConfig('Network')),
        { wrapper: createWrapper(queryClient) },
      );

      act(() => {
        result.current.form.form.setValue('url', ' http://x/ ', { shouldDirty: true });
      });
      await act(async () => {
        await result.current.form.form.handleSubmit(result.current.form.onSubmit)();
      });
      // Edit to a different raw value while in flight.
      act(() => {
        result.current.form.form.setValue('url', ' http://y/ ', { shouldDirty: true });
      });
      await act(async () => {
        save.resolve(fullSettings);
      });

      // The raw draft is retained verbatim and the card stays dirty.
      expect(result.current.form.form.getValues('url')).toBe(' http://y/ ');
      await waitFor(() => {
        expect(result.current.state.dirtyLabels).toEqual(['Network']);
      });
    });

    it('transforming schema, in-flight edit to the NORMALIZED-EQUIVALENT value (state 2): kept but clean', async () => {
      mockApi.getSettings.mockReturnValue(new Promise(() => {}));
      const save = deferSave();

      const { result } = renderHook(
        () => useFormWithProbe(transformConfig('Network')),
        { wrapper: createWrapper(queryClient) },
      );

      // Saved P = 'http://x'. Submit ' http://x/ ', then edit to 'http://x' (raw, but === P).
      act(() => {
        result.current.form.form.setValue('url', ' http://x/ ', { shouldDirty: true });
      });
      await act(async () => {
        await result.current.form.form.handleSubmit(result.current.form.onSubmit)();
      });
      act(() => {
        result.current.form.form.setValue('url', 'http://x', { shouldDirty: true });
      });
      await act(async () => {
        save.resolve(fullSettings);
      });

      // Drift occurred (a raw edit was made) so the draft is preserved, but the result
      // equals the saved value, so it settles CLEAN — the drift-vs-dirty distinction.
      expect(result.current.form.form.getValues('url')).toBe('http://x');
      await waitFor(() => {
        expect(result.current.state.dirtyLabels).toEqual([]);
      });
    });

    it('refetch does not clobber a preserved state-3 draft', async () => {
      // Settings query resolves so the post-save invalidateQueries triggers a real refetch.
      mockApi.getSettings.mockResolvedValue(fullSettings);
      const save = deferSave();

      const { result } = renderHook(
        () => useFormWithProbe({ ...hookConfig(), label: 'Test Section' }),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.form.form.getValues()).toEqual({ enabled: true, value: 42 });
      });

      // Submit V1=99, then edit to V2=123 while in flight (state 3 drift).
      act(() => {
        result.current.form.form.setValue('value', 99, { shouldDirty: true });
      });
      act(() => {
        result.current.form.mutation.mutate({ enabled: true, value: 99 });
      });
      act(() => {
        result.current.form.form.setValue('value', 123, { shouldDirty: true });
      });

      await act(async () => {
        save.resolve(fullSettings);
      });

      // The invalidateQueries refetch (getSettings call #2) must not reset the draft:
      // isDirtyRef.current was set synchronously in onSuccess before invalidation.
      await waitFor(() => {
        expect(mockApi.getSettings).toHaveBeenCalledTimes(2);
      });
      expect(result.current.form.form.getValues().value).toBe(123);
      expect(result.current.state.dirtyLabels).toEqual(['Test Section']);
    });

    it('non-transforming normal save clears and displays the submitted value', async () => {
      mockApi.getSettings.mockResolvedValue(fullSettings);
      mockApi.updateSettings.mockResolvedValue(fullSettings);

      const { result } = renderHook(
        () => useFormWithProbe({ ...hookConfig(), label: 'Test Section' }),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.form.form.getValues()).toEqual({ enabled: true, value: 42 });
      });

      act(() => {
        result.current.form.form.setValue('value', 99, { shouldDirty: true });
      });

      // No in-flight edit → clean rebaseline to the submitted value.
      await act(async () => {
        result.current.form.mutation.mutate({ enabled: true, value: 99 });
      });

      await waitFor(() => {
        expect(result.current.state.dirtyLabels).toEqual([]);
      });
      expect(result.current.form.form.getValues().value).toBe(99);
    });
  });
});
