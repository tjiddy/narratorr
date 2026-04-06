import type { UseFormRegister, UseFormWatch } from 'react-hook-form';
import type { CreateIndexerFormData } from '../../../../shared/schemas.js';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { api } from '@/lib/api';
import { ToggleSwitch } from '../ToggleSwitch';

export function UseProxyField({ register, watch }: { register: UseFormRegister<CreateIndexerFormData>; watch?: UseFormWatch<CreateIndexerFormData> }) {
  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const hasGlobalProxy = !!settings?.network?.proxyUrl;
  const useProxy = watch ? watch('settings.useProxy') : false;

  return (
    <div className="sm:col-span-2">
      <div className="flex items-center justify-between">
        <div>
          <label htmlFor="indexerUseProxy" className="block text-sm font-medium">Route through proxy</label>
          <p className="text-sm text-muted-foreground mt-0.5">
            Send search and test requests through the global proxy
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <ToggleSwitch id="indexerUseProxy" {...register('settings.useProxy')} />
        </label>
      </div>
      {useProxy && !hasGlobalProxy && (
        <p className="text-sm text-amber-500 mt-1">
          No proxy URL configured in Settings &gt; General
        </p>
      )}
    </div>
  );
}
