import { useState, useCallback, useEffect } from 'react';
import type { UseFormWatch, UseFormSetValue } from 'react-hook-form';
import type { CreateIndexerFormData } from '../../../../shared/schemas.js';
import { api } from '@/lib/api';
import type { IndexerFieldsProps } from './types.js';

export function getMinDetectionMs(mode: string): number {
  return mode === 'test' ? 0 : 1000;
}

export const MIN_DETECTION_MS = getMinDetectionMs(import.meta.env.MODE);

interface MamStatus {
  username: string;
  classname?: string;
  isVip: boolean;
  ip?: string;
}

function persistMamFields(setValue: UseFormSetValue<CreateIndexerFormData> | undefined, status: MamStatus) {
  if (!setValue) return;
  setValue('settings.isVip', status.isVip);
  setValue('settings.mamUsername', status.username);
  if (status.classname) {
    (setValue as (name: string, value: unknown) => void)('settings.classname', status.classname);
  }
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
      if (elapsed < MIN_DETECTION_MS) await new Promise((r) => setTimeout(r, MIN_DETECTION_MS - elapsed));
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
          ip: result.ip,
        };
        setMamStatus(status);
        persistMamFields(setValue, status);
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

function MamAccountCard({ status, onRefresh }: { status: MamStatus; onRefresh: () => void }) {
  const isMouse = status.classname === 'Mouse';
  const searchDesc = status.isVip
    ? 'All torrents including VIP'
    : isMouse
      ? 'Search disabled — Mouse class cannot download'
      : 'Non-VIP and freeleech torrents';

  return (
    <div className="relative mt-2 w-full sm:w-1/2 bg-white/5 border border-white/10 rounded-xl px-4 py-3 space-y-1.5">
      <button
        type="button"
        onClick={onRefresh}
        className="absolute top-3 right-3 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        title="Refresh MAM status"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
          <path d="M16 21h5v-5" />
        </svg>
      </button>
      <div className="flex items-center gap-2 text-[13px]">
        <span className="text-muted-foreground/50 min-w-[90px]">Username</span>
        <span className="text-foreground/90 font-medium">{status.username}</span>
      </div>
      <div className="flex items-center gap-2 text-[13px]">
        <span className="text-muted-foreground/50 min-w-[90px]">Class</span>
        <span className={`text-foreground/90 ${status.isVip ? 'text-amber-400 font-medium' : ''}`}>{status.classname ?? 'Unknown'}</span>
      </div>
      <div className="flex items-center gap-2 text-[13px]">
        <span className="text-muted-foreground/50 min-w-[90px]">Search</span>
        <span className={`text-foreground/90 ${isMouse ? 'text-amber-500' : ''}`}>{searchDesc}</span>
      </div>
      {status.ip && (
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground/50 min-w-[90px]">Exit IP</span>
          <span className="text-foreground/90 font-mono text-xs">{status.ip}</span>
        </div>
      )}
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
  const persistedClassname = watch ? (watch as (name: string) => unknown)('settings.classname') as string | undefined : undefined;
  if (persistedIsVip == null) return null;
  return {
    username: persistedUsername || '',
    isVip: persistedIsVip,
    classname: persistedClassname || (persistedIsVip ? 'VIP' : 'User'),
  };
}

function metadataToMamStatus(metadata: Record<string, unknown>, ip?: string): MamStatus {
  return {
    username: metadata.username as string || '',
    classname: metadata.classname as string | undefined,
    isVip: metadata.isVip as boolean,
    ip,
  };
}

export function MamFields({ register, errors, watch, setValue, formTestResult, indexerId }: Pick<IndexerFieldsProps, 'register' | 'errors' | 'watch' | 'setValue' | 'formTestResult' | 'indexerId'>) {
  const { mamStatus, detectError, isDetecting, detect, setMamStatus } = useMamDetection(watch, setValue, deriveInitialMamStatus(watch), indexerId);

  // Bridge: update card from explicit Test button result
  useEffect(() => {
    if (formTestResult?.success && formTestResult.metadata && 'isVip' in formTestResult.metadata) {
      setMamStatus(metadataToMamStatus(formTestResult.metadata, formTestResult.ip));
    }
  }, [formTestResult, setMamStatus]);

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
          <MamAccountCard status={mamStatus} onRefresh={() => {
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
    </>
  );
}
