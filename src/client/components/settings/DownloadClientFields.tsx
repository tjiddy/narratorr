import { useRef } from 'react';
import type { UseFormRegister, FieldErrors, UseFormSetValue, UseFormGetValues } from 'react-hook-form';
import type { CreateDownloadClientFormData } from '../../../shared/schemas.js';
import { DOWNLOAD_CLIENT_REGISTRY, type DownloadClientType } from '../../../shared/download-client-registry.js';
import { RefreshIcon } from '../icons';
import { ToolbarDropdown } from '../ToolbarDropdown';
import { useFetchCategories } from './useFetchCategories';
import { inputClass, errorInputClass } from './formStyles';

interface DownloadClientFieldsProps {
  selectedType: DownloadClientType;
  register: UseFormRegister<CreateDownloadClientFormData>;
  errors: FieldErrors<CreateDownloadClientFormData>;
  clientId?: number | undefined;
  setValue: UseFormSetValue<CreateDownloadClientFormData>;
  getValues: UseFormGetValues<CreateDownloadClientFormData>;
  isDirty?: boolean | undefined;
  isEdit?: boolean | undefined;
  inModal?: boolean | undefined;
}

// eslint-disable-next-line complexity -- conditional fields per client type are inherently branchy
export function DownloadClientFields({ selectedType, register, errors, clientId, setValue, getValues, isDirty, isEdit, inModal }: DownloadClientFieldsProps) {
  const meta = DOWNLOAD_CLIENT_REGISTRY[selectedType] ?? DOWNLOAD_CLIENT_REGISTRY.qbittorrent;
  const fields = meta.fieldConfig;
  const supportsCategories = meta.supportsCategories;
  const categoryInputRef = useRef<HTMLDivElement>(null);
  const { fetching, categories, error: categoryError, showDropdown, setShowDropdown, fetchCategories } =
    useFetchCategories({ selectedType, clientId, isDirty, getValues });

  function handleSelectCategory(category: string) {
    setValue('settings.category', category, { shouldDirty: true });
    setShowDropdown(false);
  }

  return (
    <>
      <div className="sm:col-span-2 grid gap-5 sm:grid-cols-[2fr_1fr_auto]" data-testid="connection-row">
        <div>
          <label htmlFor="clientHost" className="block text-sm font-medium mb-2">Host</label>
          <input id="clientHost" type="text" {...register('settings.host')} className={errorInputClass(!!errors.settings?.host)} placeholder="localhost" />
          {errors.settings?.host ? (
            <p className="text-sm text-destructive mt-1">{errors.settings.host.message}</p>
          ) : (
            <p className="text-sm text-muted-foreground mt-1">Hostname or IP without protocol</p>
          )}
        </div>
        <div>
          <label htmlFor="clientPort" className="block text-sm font-medium mb-2">Port</label>
          <input id="clientPort" type="number" step={1} {...register('settings.port', { valueAsNumber: true })} className={errorInputClass(!!errors.settings?.port)} />
          {errors.settings?.port && <p className="text-sm text-destructive mt-1">{errors.settings.port.message}</p>}
        </div>
        {fields.useSsl && (
          <label className="flex items-center gap-3 cursor-pointer pt-8">
            <input type="checkbox" {...register('settings.useSsl')} className="w-5 h-5 rounded border-border text-primary focus:ring-primary focus:ring-offset-0" />
            <span className="text-sm font-medium">SSL</span>
          </label>
        )}
      </div>

      {fields.username && (
        <div>
          <label htmlFor="clientUsername" className="block text-sm font-medium mb-2">Username</label>
          <input id="clientUsername" type="text" {...register('settings.username')} className={inputClass} placeholder="admin" />
        </div>
      )}
      {fields.password && (
        <div>
          <label htmlFor="clientPassword" className="block text-sm font-medium mb-2">Password</label>
          <input id="clientPassword" type="password" {...register('settings.password')} className={inputClass} />
        </div>
      )}

      {fields.apiKey && (
        <div className="sm:col-span-2" data-testid="api-key-field">
          <label htmlFor="clientApiKey" className="block text-sm font-medium mb-2">API Key</label>
          <input id="clientApiKey" type="password" {...register('settings.apiKey')} className={errorInputClass(!!errors.settings?.apiKey)} />
          {errors.settings?.apiKey && <p className="text-sm text-destructive mt-1">{errors.settings.apiKey.message}</p>}
        </div>
      )}

      <div className={`sm:col-span-2 grid gap-5 ${isEdit ? 'sm:grid-cols-3' : ''}`} data-testid="behavior-row">
        {isEdit && (
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" {...register('enabled')} className="w-5 h-5 rounded border-border text-primary focus:ring-primary focus:ring-offset-0" />
            <span className="text-sm font-medium">Enabled</span>
          </label>
        )}
        {isEdit && (
          <div>
            <label htmlFor="clientPriority" className="block text-sm font-medium mb-2">Priority</label>
            <input id="clientPriority" type="number" step={1} {...register('priority', { valueAsNumber: true })} className={inputClass} />
            <p className="text-sm text-muted-foreground mt-1">Lower = preferred (1-100)</p>
          </div>
        )}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <label htmlFor="clientCategory" className="block text-sm font-medium">Category</label>
            {supportsCategories && (
              <button
                type="button"
                onClick={fetchCategories}
                disabled={fetching}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground border border-border rounded-lg hover:bg-accent transition-all disabled:opacity-50"
                title="Fetch categories from client"
              >
                <RefreshIcon className={`w-3 h-3 ${fetching ? 'animate-spin' : ''}`} />
                Fetch
              </button>
            )}
          </div>
          <div ref={categoryInputRef}>
            <input id="clientCategory" type="text" {...register('settings.category')} className={inputClass} placeholder="audiobooks" />
          </div>
          <ToolbarDropdown triggerRef={categoryInputRef} open={showDropdown} onClose={() => setShowDropdown(false)} {...(inModal !== undefined && { inModal })}>
            <div className="w-64 bg-background border border-border rounded-xl shadow-lg max-h-48 overflow-y-auto">
              {categories.length > 0 ? (
                categories.map((cat) => (
                  <button key={cat} type="button" onClick={() => handleSelectCategory(cat)} className="w-full px-4 py-2.5 text-left text-sm hover:bg-accent transition-colors first:rounded-t-xl last:rounded-b-xl">
                    {cat}
                  </button>
                ))
              ) : (
                <div className="px-4 py-2.5 text-sm text-muted-foreground">No categories found</div>
              )}
            </div>
          </ToolbarDropdown>
          {categoryError ? (
            <p className="text-sm text-destructive mt-1">{categoryError}</p>
          ) : (
            <p className="text-sm text-muted-foreground mt-1">Optional. Tags downloads so the client routes them to a dedicated folder.</p>
          )}
        </div>
      </div>

    </>
  );
}
