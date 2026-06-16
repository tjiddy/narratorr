import { useState } from 'react';
import type { z } from 'zod';
import { toast } from 'sonner';
import { HeadphonesIcon, LoadingSpinner } from '@/components/icons';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { errorInputClass } from '@/components/settings/formStyles';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';
import { earwitnessFormSchema, DEFAULT_SETTINGS, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

type EarwitnessFormData = z.infer<typeof earwitnessFormSchema>;

export function EarwitnessSettings() {
  const [testing, setTesting] = useState(false);

  const { form, mutation, onSubmit } = useSettingsForm<EarwitnessFormData>({
    schema: earwitnessFormSchema,
    defaultValues: DEFAULT_SETTINGS.earwitness,
    select: (s: AppSettings) => s.earwitness as EarwitnessFormData,
    toPayload: (d) => ({ earwitness: d }),
    successMessage: 'earwitness settings saved',
  });

  const { register, handleSubmit, watch, formState: { errors, isDirty } } = form;

  const baseUrl = watch('baseUrl');
  const apiKey = watch('apiKey');
  const canTest = !!baseUrl?.trim() && !!apiKey?.trim();

  async function handleTest() {
    if (!canTest) return;
    setTesting(true);
    try {
      const result = await api.testEarwitness({ baseUrl: baseUrl.trim(), apiKey });
      if (result.success) {
        toast.success('Connected to earwitness.');
      } else {
        toast.error(result.message || 'Unable to reach server');
      }
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setTesting(false);
    }
  }

  return (
    <SettingsSection
      icon={<HeadphonesIcon className="w-5 h-5 text-primary" />}
      title="earwitness"
      description="Connect to an earwitness instance for narrator attribution analysis."
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <label htmlFor="earwitnessEnabled" className="block text-sm font-medium">Enable earwitness</label>
            <p className="text-sm text-muted-foreground mt-0.5">Allow analysing audiobooks with earwitness.</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <ToggleSwitch id="earwitnessEnabled" {...register('enabled')} />
          </label>
        </div>

        <div>
          <label htmlFor="earwitnessBaseUrl" className="block text-sm font-medium mb-2">Base URL</label>
          <input
            id="earwitnessBaseUrl"
            type="text"
            {...register('baseUrl')}
            className={errorInputClass(!!errors.baseUrl)}
            placeholder="http://earwitness:8080"
          />
          {errors.baseUrl ? (
            <p className="text-sm text-destructive mt-1">{errors.baseUrl.message}</p>
          ) : (
            <p className="text-sm text-muted-foreground mt-2">
              The address of your earwitness instance. May be a private/LAN address.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="earwitnessApiKey" className="block text-sm font-medium mb-2">API Key</label>
          <div className="flex gap-2">
            <input
              id="earwitnessApiKey"
              type="password"
              autoComplete="off"
              {...register('apiKey')}
              className="flex-1 px-4 py-3 bg-background border border-border rounded-xl focus-ring focus:border-transparent transition-all"
              placeholder="Paste your earwitness API key"
            />
            <button
              type="button"
              onClick={handleTest}
              disabled={!canTest || testing}
              className="flex items-center gap-2 px-4 py-3 bg-muted text-foreground font-medium rounded-xl hover:bg-muted/80 disabled:opacity-50 transition-all whitespace-nowrap"
            >
              {testing ? (
                <>
                  <LoadingSpinner className="w-4 h-4" />
                  Testing...
                </>
              ) : (
                'Test Connection'
              )}
            </button>
          </div>
          <p className="text-sm text-muted-foreground mt-2">
            Sent as the <code>X-Api-Key</code> header on every earwitness request.
          </p>
        </div>

        {isDirty && (
          <button
            type="submit"
            disabled={mutation.isPending}
            className="px-4 py-2.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all text-sm focus-ring animate-fade-in"
          >
            {mutation.isPending ? 'Saving...' : 'Save'}
          </button>
        )}
      </form>
    </SettingsSection>
  );
}
