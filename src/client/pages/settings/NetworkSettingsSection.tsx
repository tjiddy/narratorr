import { useState } from 'react';
import type { UseFormRegister, FieldErrors, UseFormWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { WifiIcon, LoadingSpinner } from '@/components/icons';
import { api } from '@/lib/api';
import type { UpdateSettingsFormData } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

interface NetworkSettingsSectionProps {
  register: UseFormRegister<UpdateSettingsFormData>;
  errors: FieldErrors<UpdateSettingsFormData>;
  watch: UseFormWatch<UpdateSettingsFormData>;
}

export function NetworkSettingsSection({ register, errors, watch }: NetworkSettingsSectionProps) {
  const [testing, setTesting] = useState(false);
  const proxyUrl = watch('network.proxyUrl');

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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Proxy test failed');
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
      <div>
        <label htmlFor="proxyUrl" className="block text-sm font-medium mb-2">Proxy URL</label>
        <div className="flex gap-3">
          <input
            id="proxyUrl"
            type="text"
            {...register('network.proxyUrl')}
            className={`flex-1 px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
              errors.network?.proxyUrl ? 'border-destructive' : 'border-border'
            }`}
            placeholder="http://gluetun:8888 or socks5://localhost:1080"
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
        {errors.network?.proxyUrl ? (
          <p className="text-sm text-destructive mt-1">{errors.network.proxyUrl.message}</p>
        ) : (
          <p className="text-sm text-muted-foreground mt-2">
            Route indexer search and test traffic through an HTTP or SOCKS5 proxy. Enable per-indexer in Settings &gt; Indexers.
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
