import type { UseFormRegister, FieldErrors } from 'react-hook-form';
import type { CreateDownloadClientFormData } from '../../../shared/schemas.js';
import { SelectWithChevron } from './SelectWithChevron';

interface BlackholeFieldsProps {
  register: UseFormRegister<CreateDownloadClientFormData>;
  errors: FieldErrors<CreateDownloadClientFormData>;
  isEdit?: boolean;
}

const inputClass = 'w-full px-4 py-3 bg-background border border-border rounded-xl focus-ring focus:border-transparent transition-all';
const errorInputClass = 'w-full px-4 py-3 bg-background border border-destructive rounded-xl focus-ring focus:border-transparent transition-all';

export function BlackholeFields({ register, errors, isEdit }: BlackholeFieldsProps) {
  return (
    <>
      <div className="sm:col-span-2">
        <label htmlFor="clientWatchDir" className="block text-sm font-medium mb-2">Watch Directory</label>
        <input id="clientWatchDir" type="text" {...register('settings.watchDir')} className={errors.settings?.watchDir ? errorInputClass : inputClass} placeholder="/downloads/watch" />
        {errors.settings?.watchDir ? (
          <p className="text-sm text-destructive mt-1">{errors.settings.watchDir.message}</p>
        ) : (
          <p className="text-sm text-muted-foreground mt-1">Directory where .torrent/.nzb files will be saved for your external client to pick up</p>
        )}
      </div>

      <div>
        <label htmlFor="clientProtocol" className="block text-sm font-medium mb-2">Protocol</label>
        <SelectWithChevron id="clientProtocol" {...register('settings.protocol')} error={!!errors.settings?.protocol}>
          <option value="torrent">Torrent</option>
          <option value="usenet">Usenet</option>
        </SelectWithChevron>
        {errors.settings?.protocol ? (
          <p className="text-sm text-destructive mt-1">{errors.settings.protocol.message}</p>
        ) : (
          <p className="text-sm text-muted-foreground mt-1">File type to write (.torrent or .nzb)</p>
        )}
      </div>

      {isEdit && (
        <div className="sm:col-span-2 grid gap-5 sm:grid-cols-2" data-testid="behavior-row">
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" {...register('enabled')} className="w-5 h-5 rounded border-border text-primary focus:ring-primary focus:ring-offset-0" />
            <span className="text-sm font-medium">Enabled</span>
          </label>
          <div>
            <label htmlFor="clientPriority" className="block text-sm font-medium mb-2">Priority</label>
            <input id="clientPriority" type="number" {...register('priority', { valueAsNumber: true })} className={inputClass} />
            <p className="text-sm text-muted-foreground mt-1">Lower = preferred (1-100)</p>
          </div>
        </div>
      )}
    </>
  );
}
