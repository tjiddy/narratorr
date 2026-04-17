import { useState } from 'react';
import { z } from 'zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';
import { WifiIcon, LoadingSpinner } from '@/components/icons';
import { errorInputClass } from '@/components/settings/formStyles';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

const VALID_PROXY_SCHEMES = ['http:', 'https:', 'socks5:'];
const SENTINEL = '********';

const networkFormSchema = z.object({
  proxyUrl: z.string().transform((val) => {
    const trimmed = val.trim();
    if (!trimmed) return '';
    if (trimmed === SENTINEL) return SENTINEL;
    return trimmed.replace(/\/+$/, '');
  }).pipe(
    z.string().refine((val) => {
      if (!val) return true;
      if (val === SENTINEL) return true;
      try {
        const url = new URL(val);
        return VALID_PROXY_SCHEMES.includes(url.protocol);
      } catch {
        return false;
      }
    }, { message: 'Must be a valid URL with http, https, or socks5 scheme' }),
  ),
});

type NetworkFormData = z.infer<typeof networkFormSchema>;

export function NetworkSettingsSection() {
  const [testing, setTesting] = useState(false);

  const { form, mutation, onSubmit } = useSettingsForm<NetworkFormData>({
    schema: networkFormSchema,
    defaultValues: DEFAULT_SETTINGS.network,
    select: (s: AppSettings) => s.network as NetworkFormData,
    toPayload: (d) => ({ network: d }),
    successMessage: 'Network settings saved',
  });

  const { register, handleSubmit, watch, formState: { errors, isDirty } } = form;

  const proxyUrl = watch('proxyUrl');

  async function handleTestProxy() {
    if (!proxyUrl?.trim()) return;

    setTesting(true);
    try {
      const result = await api.testProxy(proxyUrl.trim());
      if (result.success && result.ip) {
        toast.success(`Proxy connected — exit IP: ${result.ip}`);
      } else {
        toast.error(result.message || 'Proxy test failed');
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error));
    } finally {
      setTesting(false);
    }
  }

  return (
    <SettingsSection
      icon={<WifiIcon className="w-5 h-5 text-primary" />}
      title="Network"
      description="Configure proxy for indexer traffic"
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <div>
          <label htmlFor="proxyUrl" className="block text-sm font-medium mb-2">Proxy URL</label>
          <div className="flex gap-3">
            <input
              id="proxyUrl"
              type="text"
              {...register('proxyUrl')}
              className={`flex-1 ${errorInputClass(!!errors.proxyUrl)}`}
              placeholder="http://user:pass@proxy:8888 or socks5://localhost:1080"
            />
            <button
              type="button"
              onClick={handleTestProxy}
              disabled={!proxyUrl?.trim() || testing}
              className="flex items-center gap-2 px-4 py-3 bg-muted text-foreground font-medium rounded-xl hover:bg-muted/80 disabled:opacity-50 transition-all whitespace-nowrap"
            >
              {testing ? (
                <>
                  <LoadingSpinner className="w-4 h-4" />
                  Testing...
                </>
              ) : (
                'Test Proxy'
              )}
            </button>
          </div>
          {errors.proxyUrl ? (
            <p className="text-sm text-destructive mt-1">{errors.proxyUrl.message}</p>
          ) : (
            <p className="text-sm text-muted-foreground mt-2">
              Route indexer search and test traffic through an HTTP or SOCKS5 proxy. Enable per-indexer in Settings &gt; Indexers.
            </p>
          )}
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
