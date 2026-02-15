import { useEffect, useRef, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import {
  LoadingSpinner,
  FolderIcon,
  SearchIcon,
  CheckIcon,
  TerminalIcon,
  PackageIcon,
} from '@/components/icons';
import { renderTemplate, ALLOWED_TOKENS } from '@narratorr/core/utils';
import {
  updateSettingsFormSchema,
  logLevelSchema,
  type UpdateSettingsFormData,
} from '../../../shared/schemas.js';

export function GeneralSettings() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const folderFormatRef = useRef<HTMLInputElement | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<UpdateSettingsFormData>({
    resolver: zodResolver(updateSettingsFormSchema),
    defaultValues: {
      library: {
        path: '',
        folderFormat: '{author}/{title}',
      },
      search: {
        enabled: false,
        intervalMinutes: 360,
        autoGrab: false,
      },
      import: {
        deleteAfterImport: false,
        minSeedTime: 60,
      },
      general: {
        logLevel: 'info' as const,
      },
    },
  });

  // Reset form when settings are loaded
  useEffect(() => {
    if (settings) {
      reset({
        library: {
          path: settings.library.path,
          folderFormat: settings.library.folderFormat,
        },
        search: {
          enabled: settings.search?.enabled ?? false,
          intervalMinutes: settings.search?.intervalMinutes ?? 360,
          autoGrab: settings.search?.autoGrab ?? false,
        },
        import: {
          deleteAfterImport: settings.import?.deleteAfterImport ?? false,
          minSeedTime: settings.import?.minSeedTime ?? 60,
        },
        general: {
          logLevel: settings.general?.logLevel || 'info',
        },
      });
    }
  }, [settings, reset]);

  const mutation = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Settings saved successfully');
    },
    onError: () => {
      toast.error('Failed to save settings');
    },
  });

  const folderFormat = watch('library.folderFormat');

  const previewPath = useMemo(() => {
    if (!folderFormat) return '';
    return renderTemplate(folderFormat, {
      author: 'Brandon Sanderson',
      title: 'The Way of Kings',
      series: 'The Stormlight Archive',
      seriesPosition: 1,
      year: '2010',
      narrator: 'Michael Kramer, Kate Reading',
    });
  }, [folderFormat]);

  const hasTitleToken = folderFormat ? /\{title(?::\d+)?(?:\?[^}]*)?\}/.test(folderFormat) : true;
  const hasAuthorToken = folderFormat ? /\{author(?::\d+)?(?:\?[^}]*)?\}/.test(folderFormat) : true;

  const insertToken = (token: string) => {
    const input = folderFormatRef.current;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const newValue = `${before}{${token}}${after}`;
    setValue('library.folderFormat', newValue, { shouldDirty: true, shouldValidate: true });
    // Restore cursor position after the inserted token
    requestAnimationFrame(() => {
      const pos = start + token.length + 2; // +2 for { }
      input.setSelectionRange(pos, pos);
      input.focus();
    });
  };

  const onSubmit = (data: UpdateSettingsFormData) => {
    mutation.mutate(data);
  };

  if (isLoading || !settings) {
    return (
      <div className="flex items-center justify-center py-24">
        <LoadingSpinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-8">
      <div className="glass-card rounded-2xl p-6 sm:p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-primary/10 rounded-xl">
            <FolderIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Library</h2>
            <p className="text-sm text-muted-foreground">Configure where audiobooks are stored</p>
          </div>
        </div>

        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium mb-2">Library Path</label>
            <input
              type="text"
              {...register('library.path')}
              className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                errors.library?.path ? 'border-destructive' : 'border-border'
              }`}
              placeholder="/audiobooks"
            />
            {errors.library?.path && (
              <p className="text-sm text-destructive mt-1">{errors.library.path.message}</p>
            )}
            <p className="text-sm text-muted-foreground mt-2">
              The root folder where imported audiobooks will be stored
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Folder Format</label>
            <input
              type="text"
              {...(() => {
                const { ref: rhfRef, ...rest } = register('library.folderFormat');
                return {
                  ...rest,
                  ref: (el: HTMLInputElement | null) => {
                    rhfRef(el);
                    folderFormatRef.current = el;
                  },
                };
              })()}
              className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all font-mono text-sm ${
                errors.library?.folderFormat ? 'border-destructive' : 'border-border'
              }`}
              placeholder="{author}/{title}"
            />
            {errors.library?.folderFormat && (
              <p className="text-sm text-destructive mt-1">{errors.library.folderFormat.message}</p>
            )}

            {/* Token chips */}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {ALLOWED_TOKENS.map((token) => (
                <button
                  key={token}
                  type="button"
                  onClick={() => insertToken(token)}
                  className="px-2 py-1 bg-muted hover:bg-muted/80 text-xs font-mono rounded-md transition-colors cursor-pointer"
                >
                  {`{${token}}`}
                </button>
              ))}
            </div>

            {/* Validation feedback */}
            {!hasTitleToken && (
              <p className="text-sm text-destructive mt-2">
                Template must include {'{title}'}
              </p>
            )}
            {hasTitleToken && !hasAuthorToken && (
              <p className="text-sm text-amber-500 mt-2">
                Consider including {'{author}'} for better organization
              </p>
            )}

            {/* Live preview */}
            {folderFormat && (
              <div className="mt-3 p-3 bg-muted/50 rounded-lg border border-border">
                <p className="text-xs text-muted-foreground mb-1">Preview</p>
                <p className="text-sm font-mono break-all">{previewPath || <span className="text-muted-foreground italic">Empty path</span>}</p>
              </div>
            )}

            <p className="text-sm text-muted-foreground mt-2">
              Use conditional blocks like <code className="px-1 py-0.5 bg-muted rounded text-xs">{'{series? - }'}</code> to add separators only when a value exists.
              Use <code className="px-1 py-0.5 bg-muted rounded text-xs">{'{seriesPosition:00}'}</code> for zero-padding.
            </p>
          </div>
        </div>
      </div>

      <div className="glass-card rounded-2xl p-6 sm:p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-primary/10 rounded-xl">
            <SearchIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Search</h2>
            <p className="text-sm text-muted-foreground">Automatic searching for wanted books</p>
          </div>
        </div>

        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium">Enable Scheduled Search</label>
              <p className="text-sm text-muted-foreground mt-0.5">
                Periodically search indexers for books in your wanted list
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                {...register('search.enabled')}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Search Interval (minutes)</label>
            <input
              type="number"
              {...register('search.intervalMinutes', { valueAsNumber: true })}
              className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                errors.search?.intervalMinutes ? 'border-destructive' : 'border-border'
              }`}
              min={5}
              max={1440}
              placeholder="360"
            />
            {errors.search?.intervalMinutes && (
              <p className="text-sm text-destructive mt-1">{errors.search.intervalMinutes.message}</p>
            )}
            <p className="text-sm text-muted-foreground mt-2">
              How often to search for new releases (5-1440 minutes)
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium">Auto-Grab Best Result</label>
              <p className="text-sm text-muted-foreground mt-0.5">
                Automatically grab the best result (most seeders) when a match is found
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                {...register('search.autoGrab')}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>
        </div>
      </div>

      <div className="glass-card rounded-2xl p-6 sm:p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-primary/10 rounded-xl">
            <PackageIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Import</h2>
            <p className="text-sm text-muted-foreground">Configure post-download import behavior</p>
          </div>
        </div>

        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium">Delete After Import</label>
              <p className="text-sm text-muted-foreground mt-0.5">
                Remove torrent from download client after files are imported
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                {...register('import.deleteAfterImport')}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Minimum Seed Time (minutes)</label>
            <input
              type="number"
              {...register('import.minSeedTime', { valueAsNumber: true })}
              className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                errors.import?.minSeedTime ? 'border-destructive' : 'border-border'
              }`}
              min={0}
              placeholder="60"
            />
            {errors.import?.minSeedTime && (
              <p className="text-sm text-destructive mt-1">{errors.import.minSeedTime.message}</p>
            )}
            <p className="text-sm text-muted-foreground mt-2">
              How long to seed before removing the torrent (only applies when delete after import is enabled)
            </p>
          </div>
        </div>
      </div>

      <div className="glass-card rounded-2xl p-6 sm:p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-primary/10 rounded-xl">
            <TerminalIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Logging</h2>
            <p className="text-sm text-muted-foreground">Control server log verbosity</p>
          </div>
        </div>

        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium mb-2">Log Level</label>
            <select
              {...register('general.logLevel')}
              className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
            >
              {logLevelSchema.options.map((level) => (
                <option key={level} value={level}>
                  {level.charAt(0).toUpperCase() + level.slice(1)}
                </option>
              ))}
            </select>
            <p className="text-sm text-muted-foreground mt-2">
              Set to Debug for detailed diagnostic output, or Error to reduce noise
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={mutation.isPending || !isDirty}
          className="flex items-center gap-2 px-5 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all focus-ring"
        >
          {mutation.isPending ? (
            <>
              <LoadingSpinner className="w-4 h-4" />
              Saving...
            </>
          ) : (
            <>
              <CheckIcon className="w-4 h-4" />
              Save Changes
            </>
          )}
        </button>
      </div>
    </form>
  );
}
