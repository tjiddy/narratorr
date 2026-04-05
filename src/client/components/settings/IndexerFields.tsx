import { useState, useCallback, useEffect } from 'react';
import type { UseFormRegister, FieldErrors, UseFormWatch, UseFormSetValue } from 'react-hook-form';
import type { CreateIndexerFormData } from '../../../shared/schemas.js';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { api } from '@/lib/api';
import { ToggleSwitch } from './ToggleSwitch';
import { MAM_LANGUAGES, MAM_SEARCH_TYPES } from '../../../shared/indexer-registry.js';
import { SelectWithChevron } from './SelectWithChevron';

interface IndexerFieldsProps {
  selectedType: string;
  register: UseFormRegister<CreateIndexerFormData>;
  errors: FieldErrors<CreateIndexerFormData>;
  watch?: UseFormWatch<CreateIndexerFormData>;
  setValue?: UseFormSetValue<CreateIndexerFormData>;
  prowlarrManaged?: boolean;
  formTestResult?: { success: boolean; metadata?: Record<string, unknown> } | null;
  indexerId?: number;
}

type FieldComponent = (props: Pick<IndexerFieldsProps, 'register' | 'errors' | 'watch' | 'setValue' | 'formTestResult' | 'indexerId'> & { selectedType: string; prowlarrManaged?: boolean }) => React.JSX.Element;

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

interface MamStatus {
  username: string;
  classname?: string;
  isVip: boolean;
}

function useMamDetection(watch?: UseFormWatch<CreateIndexerFormData>, setValue?: UseFormSetValue<CreateIndexerFormData>, initialStatus?: MamStatus | null, indexerId?: number) {
  const [mamStatus, setMamStatus] = useState<MamStatus | null>(initialStatus ?? null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);

  const detect = useCallback(async (mamId: string) => {
    if (!mamId.trim()) return;
    const isSentinel = mamId === '********';
    if (isSentinel && indexerId == null) return;

    setIsDetecting(true);
    setDetectError(null);
    const startTime = Date.now();

    async function ensureMinDuration() {
      const elapsed = Date.now() - startTime;
      if (elapsed < 1000) await new Promise((r) => setTimeout(r, 1000 - elapsed));
    }

    try {
      const baseUrl = watch ? (watch('settings.baseUrl') || '') : '';
      const useProxy = watch ? (watch('settings.useProxy') || false) : false;
      const result = await api.testIndexerConfig({
        name: 'Detection', type: 'myanonamouse', enabled: true, priority: 0,
        settings: { mamId, baseUrl, useProxy },
        ...(isSentinel && indexerId != null ? { id: indexerId } : {}),
      });
      await ensureMinDuration();

      if (result.success && result.metadata) {
        const status: MamStatus = {
          username: result.metadata.username as string,
          classname: result.metadata.classname as string | undefined,
          isVip: result.metadata.isVip as boolean,
        };
        setMamStatus(status);
        if (setValue) {
          setValue('settings.isVip', status.isVip);
          setValue('settings.mamUsername', status.username);
        }
      } else {
        setDetectError(result.message || 'Detection failed');
        setMamStatus(null);
      }
    } catch {
      await ensureMinDuration();
      setDetectError('Connection failed');
      setMamStatus(null);
    }
    setIsDetecting(false);
  }, [watch, setValue, indexerId]);

  return { mamStatus, detectError, isDetecting, detect, setMamStatus };
}

function MamStatusBadge({ status, onRefresh }: { status: MamStatus; onRefresh: () => void }) {
  return (
    <div className="flex items-center gap-2 mt-1">
      <span className="text-sm text-muted-foreground">
        Connected as <span className="font-medium text-foreground">{status.username}</span>
        {status.classname && <> — <span className={status.isVip ? 'text-amber-400 font-medium' : ''}>{status.classname}</span></>}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        className="text-muted-foreground hover:text-foreground transition-colors"
        title="Refresh VIP status"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
          <path d="M16 21h5v-5" />
        </svg>
      </button>
    </div>
  );
}

function DetectionOverlay() {
  return (
    <div className="sm:col-span-2 relative flex items-center justify-center py-4">
      <div className="bg-card border border-border rounded-2xl px-6 py-4 shadow-xl flex items-center gap-3">
        <svg className="w-5 h-5 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <span className="text-sm font-medium">Checking MAM status…</span>
      </div>
    </div>
  );
}

function deriveInitialMamStatus(watch?: UseFormWatch<CreateIndexerFormData>): MamStatus | null {
  const persistedIsVip = watch ? watch('settings.isVip') : undefined;
  const persistedUsername = watch ? watch('settings.mamUsername') : undefined;
  if (persistedIsVip == null) return null;
  return {
    username: persistedUsername || '',
    isVip: persistedIsVip,
    classname: persistedIsVip ? 'VIP' : 'User',
  };
}

function metadataToMamStatus(metadata: Record<string, unknown>): MamStatus {
  return {
    username: metadata.username as string || '',
    classname: metadata.classname as string | undefined,
    isVip: metadata.isVip as boolean,
  };
}

function MamFields({ register, errors, watch, setValue, formTestResult, indexerId }: Pick<IndexerFieldsProps, 'register' | 'errors' | 'watch' | 'setValue' | 'formTestResult' | 'indexerId'>) {
  const searchLanguages = watch ? (watch('settings.searchLanguages') ?? [1]) : [1];
  const { mamStatus, detectError, isDetecting, detect, setMamStatus } = useMamDetection(watch, setValue, deriveInitialMamStatus(watch), indexerId);

  // Bridge: update badge from explicit Test button result
  useEffect(() => {
    if (formTestResult?.success && formTestResult.metadata && 'isVip' in formTestResult.metadata) {
      setMamStatus(metadataToMamStatus(formTestResult.metadata));
    }
  }, [formTestResult, setMamStatus]);

  function toggleLanguage(langId: number) {
    if (!setValue) return;
    const updated = searchLanguages.includes(langId)
      ? searchLanguages.filter((id) => id !== langId)
      : [...searchLanguages, langId];
    setValue('settings.searchLanguages', updated, { shouldValidate: true });
  }

  const mamIdRegistration = register('settings.mamId');

  return (
    <>
      <div className="sm:col-span-2">
        <label htmlFor="indexerMamId" className="block text-sm font-medium mb-2">MAM ID</label>
        <input
          id="indexerMamId"
          type="password"
          {...mamIdRegistration}
          onBlur={(e) => {
            mamIdRegistration.onBlur(e);
            const val = e.target.value.trim();
            if (val && val !== '********') detect(val);
          }}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
            errors.settings?.mamId ? 'border-destructive' : 'border-border'
          }`}
        />
        {errors.settings?.mamId ? (
          <p className="text-sm text-destructive mt-1">{errors.settings.mamId.message}</p>
        ) : mamStatus ? (
          <MamStatusBadge status={mamStatus} onRefresh={() => {
            const mamId = watch ? watch('settings.mamId') : '';
            if (mamId) detect(mamId);
          }} />
        ) : detectError ? (
          <p className="text-sm text-destructive mt-1">{detectError}</p>
        ) : (
          <p className="text-sm text-muted-foreground mt-1">Generate from MAM &gt; Preferences &gt; Security &gt; Create Session</p>
        )}
      </div>

      {isDetecting && <DetectionOverlay />}
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
      <div className="sm:col-span-2">
        <span className="block text-sm font-medium mb-2">Languages</span>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {MAM_LANGUAGES.map((lang) => (
            <label key={lang.id} className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={searchLanguages.includes(lang.id)}
                onChange={() => toggleLanguage(lang.id)}
                className="rounded border-border text-primary focus-ring"
              />
              {lang.label}
            </label>
          ))}
        </div>
        <p className="text-sm text-muted-foreground mt-1">Deselect all for unrestricted language search</p>
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="indexerSearchType" className="block text-sm font-medium mb-2">Search Type</label>
        <SelectWithChevron
          id="indexerSearchType"
          {...register('settings.searchType')}
        >
          {MAM_SEARCH_TYPES.map((st) => (
            <option key={st.value} value={st.value}>{st.label}</option>
          ))}
        </SelectWithChevron>
        <p className="text-sm text-muted-foreground mt-1">Auto-overridden by VIP status when detected</p>
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

export function IndexerFields({ selectedType, register, errors, watch, setValue, prowlarrManaged, formTestResult, indexerId }: IndexerFieldsProps) {
  const Component = FIELD_COMPONENTS[selectedType];
  if (!Component) return null;
  return (
    <>
      <Component register={register} errors={errors} watch={watch} setValue={setValue} selectedType={selectedType} prowlarrManaged={prowlarrManaged} formTestResult={formTestResult} indexerId={indexerId} />
      <UseProxyField register={register} watch={watch} />
    </>
  );
}
