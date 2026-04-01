import type { UseFormRegister, FieldErrors, UseFormWatch } from 'react-hook-form';
import type { CreateIndexerFormData } from '../../../shared/schemas.js';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { api } from '@/lib/api';

interface IndexerFieldsProps {
  selectedType: string;
  register: UseFormRegister<CreateIndexerFormData>;
  errors: FieldErrors<CreateIndexerFormData>;
  watch?: UseFormWatch<CreateIndexerFormData>;
  prowlarrManaged?: boolean;
}

type FieldComponent = (props: Pick<IndexerFieldsProps, 'register' | 'errors'> & { selectedType: string; prowlarrManaged?: boolean }) => React.JSX.Element;

function FlareSolverrField({ register, errors }: Pick<IndexerFieldsProps, 'register' | 'errors'>) {
  return (
    <div className="sm:col-span-2">
      <label htmlFor="indexerFlareSolverrUrl" className="block text-sm font-medium mb-2">
        FlareSolverr URL
        <span className="text-muted-foreground font-normal ml-1">(optional)</span>
      </label>
      <input
        id="indexerFlareSolverrUrl"
        type="text"
        {...register('settings.flareSolverrUrl')}
        className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
          errors.settings?.flareSolverrUrl ? 'border-destructive' : 'border-border'
        }`}
        placeholder="http://flaresolverr:8191"
      />
      {errors.settings?.flareSolverrUrl ? (
        <p className="text-sm text-destructive mt-1">{errors.settings.flareSolverrUrl.message}</p>
      ) : (
        <p className="text-sm text-muted-foreground mt-1">Improves reliability at the cost of performance. Routes requests through FlareSolverr/Byparr to bypass Cloudflare.</p>
      )}
    </div>
  );
}

function AbbFields({ register, errors }: Pick<IndexerFieldsProps, 'register' | 'errors'>) {
  return (
    <>
      <div>
        <label htmlFor="indexerHostname" className="block text-sm font-medium mb-2">Hostname</label>
        <input
          id="indexerHostname"
          type="text"
          {...register('settings.hostname')}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
            errors.settings?.hostname ? 'border-destructive' : 'border-border'
          }`}
          placeholder="audiobookbay.lu"
        />
        {errors.settings?.hostname ? (
          <p className="text-sm text-destructive mt-1">{errors.settings.hostname.message}</p>
        ) : (
          <p className="text-sm text-muted-foreground mt-1">Domain only, without http:// or https://</p>
        )}
      </div>
      <div>
        <label htmlFor="indexerPageLimit" className="block text-sm font-medium mb-2">Page Limit</label>
        <input
          id="indexerPageLimit"
          type="number"
          {...register('settings.pageLimit', { valueAsNumber: true })}
          min={1}
          max={10}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
            errors.settings?.pageLimit ? 'border-destructive' : 'border-border'
          }`}
        />
        {errors.settings?.pageLimit && (
          <p className="text-sm text-destructive mt-1">{errors.settings.pageLimit.message}</p>
        )}
      </div>
      <FlareSolverrField register={register} errors={errors} />
    </>
  );
}

function ApiFields({ register, errors, selectedType, prowlarrManaged }: Pick<IndexerFieldsProps, 'register' | 'errors'> & { selectedType: string; prowlarrManaged?: boolean }) {
  const readOnlyClass = prowlarrManaged ? 'opacity-60 cursor-not-allowed' : '';
  return (
    <>
      <div className="sm:col-span-2">
        <label htmlFor="indexerApiUrl" className="block text-sm font-medium mb-2">API URL</label>
        <input
          id="indexerApiUrl"
          type="text"
          {...register('settings.apiUrl')}
          readOnly={prowlarrManaged}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
            errors.settings?.apiUrl ? 'border-destructive' : 'border-border'
          } ${readOnlyClass}`}
          placeholder="https://indexer.example.com/api"
        />
        {errors.settings?.apiUrl ? (
          <p className="text-sm text-destructive mt-1">{errors.settings.apiUrl.message}</p>
        ) : (
          <p className="text-sm text-muted-foreground mt-1">Full URL to the {selectedType} API endpoint</p>
        )}
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="indexerApiKey" className="block text-sm font-medium mb-2">API Key</label>
        <input
          id="indexerApiKey"
          type="password"
          {...register('settings.apiKey')}
          readOnly={prowlarrManaged}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
            errors.settings?.apiKey ? 'border-destructive' : 'border-border'
          } ${readOnlyClass}`}
        />
        {errors.settings?.apiKey && (
          <p className="text-sm text-destructive mt-1">{errors.settings.apiKey.message}</p>
        )}
      </div>
      <FlareSolverrField register={register} errors={errors} />
    </>
  );
}

function MamFields({ register, errors }: Pick<IndexerFieldsProps, 'register' | 'errors'>) {
  return (
    <>
      <div className="sm:col-span-2">
        <label htmlFor="indexerMamId" className="block text-sm font-medium mb-2">MAM ID</label>
        <input
          id="indexerMamId"
          type="password"
          {...register('settings.mamId')}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
            errors.settings?.mamId ? 'border-destructive' : 'border-border'
          }`}
        />
        {errors.settings?.mamId ? (
          <p className="text-sm text-destructive mt-1">{errors.settings.mamId.message}</p>
        ) : (
          <p className="text-sm text-muted-foreground mt-1">Generate from MAM &gt; Preferences &gt; Security &gt; Create Session</p>
        )}
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="indexerBaseUrl" className="block text-sm font-medium mb-2">
          Base URL
          <span className="text-muted-foreground font-normal ml-1">(optional)</span>
        </label>
        <input
          id="indexerBaseUrl"
          type="text"
          {...register('settings.baseUrl')}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
            errors.settings?.baseUrl ? 'border-destructive' : 'border-border'
          }`}
          placeholder="https://www.myanonamouse.net"
        />
        {errors.settings?.baseUrl ? (
          <p className="text-sm text-destructive mt-1">{errors.settings.baseUrl.message}</p>
        ) : (
          <p className="text-sm text-muted-foreground mt-1">Only change if using a custom MAM mirror</p>
        )}
      </div>
    </>
  );
}

const FIELD_COMPONENTS: Record<string, FieldComponent> = {
  abb: AbbFields,
  torznab: ApiFields,
  newznab: ApiFields,
  myanonamouse: MamFields,
};

function UseProxyField({ register, watch }: { register: UseFormRegister<CreateIndexerFormData>; watch?: UseFormWatch<CreateIndexerFormData> }) {
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
          <input id="indexerUseProxy" type="checkbox" {...register('settings.useProxy')} className="sr-only peer" />
          <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
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

export function IndexerFields({ selectedType, register, errors, watch, prowlarrManaged }: IndexerFieldsProps) {
  const Component = FIELD_COMPONENTS[selectedType];
  if (!Component) return null;
  return (
    <>
      <Component register={register} errors={errors} selectedType={selectedType} prowlarrManaged={prowlarrManaged} />
      <UseProxyField register={register} watch={watch} />
    </>
  );
}
