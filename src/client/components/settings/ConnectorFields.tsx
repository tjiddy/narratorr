import type { FieldError, Path, UseFormReturn } from 'react-hook-form';
import { useFieldArray } from 'react-hook-form';
import type { ConnectorTarget } from '@/lib/api';
import { FormField } from './FormField';
import { SelectWithChevron } from './SelectWithChevron';
import { btnSecondary, inputClass } from './formStyles';
import {
  CONNECTOR_REGISTRY,
  type ConnectorSettingsField,
  type ConnectorType,
} from '../../../shared/connector-registry.js';
import type { CreateConnectorFormData } from '../../../shared/schemas.js';

type ConnectorForm = UseFormReturn<CreateConnectorFormData>;
type SettingsErrors = Record<string, FieldError | undefined> | undefined;

function settingsPath(key: string): Path<CreateConnectorFormData> {
  return `settings.${key}` as Path<CreateConnectorFormData>;
}

interface ConnectorFieldsProps {
  form: ConnectorForm;
  selectedType: ConnectorType;
  targets: ConnectorTarget[];
  fetching: boolean;
  fetchError: string;
  onFetchTargets: () => void;
}

/**
 * Registry-driven per-type connector form fields. Renders inputs in the order
 * declared by `CONNECTOR_REGISTRY[type].settingsFields`, choosing the control by
 * `field.type` — so adding a connector (e.g. Plex) needs only a registry entry,
 * not a hardcoded field block (mirrors NotifierFields / IndexerFields).
 */
export function ConnectorFields({ form, selectedType, targets, fetching, fetchError, onFetchTargets }: ConnectorFieldsProps) {
  const fields = CONNECTOR_REGISTRY[selectedType]?.settingsFields ?? [];
  return (
    <>
      {fields.map((field) => (
        <ConnectorFieldControl
          key={field.key}
          field={field}
          form={form}
          targets={targets}
          fetching={fetching}
          fetchError={fetchError}
          onFetchTargets={onFetchTargets}
        />
      ))}
    </>
  );
}

interface ControlProps {
  field: ConnectorSettingsField;
  form: ConnectorForm;
  targets: ConnectorTarget[];
  fetching: boolean;
  fetchError: string;
  onFetchTargets: () => void;
}

function ConnectorFieldControl({ field, form, targets, fetching, fetchError, onFetchTargets }: ControlProps) {
  const errors = form.formState.errors.settings as SettingsErrors;
  const error = errors?.[field.key];
  switch (field.type) {
    case 'password':
    case 'text':
      return (
        <FormField
          id={`connector-${field.key}`}
          label={field.label}
          type={field.type === 'password' ? 'password' : 'text'}
          className={field.key === 'baseUrl' ? 'sm:col-span-2' : ''}
          registration={form.register(settingsPath(field.key))}
          error={error}
          placeholder={field.placeholder}
        />
      );
    case 'select':
      return <SelectField field={field} form={form} error={error} targets={targets} fetching={fetching} fetchError={fetchError} onFetchTargets={onFetchTargets} />;
    case 'path-mappings':
      return <PathMappingsField form={form} field={field} />;
    case 'toggle':
      return <ToggleField form={form} field={field} />;
    default:
      return null;
  }
}

interface SelectFieldProps {
  field: ConnectorSettingsField;
  form: ConnectorForm;
  error: FieldError | undefined;
  targets: ConnectorTarget[];
  fetching: boolean;
  fetchError: string;
  onFetchTargets: () => void;
}

function SelectField({ field, form, error, targets, fetching, fetchError, onFetchTargets }: SelectFieldProps) {
  const id = `connector-${field.key}`;
  const registration = form.register(settingsPath(field.key));
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium mb-2">{field.label}</label>
      <div className="flex gap-2">
        {targets.length > 0 ? (
          <SelectWithChevron id={id} {...registration} error={!!error}>
            <option value="">{`Select a ${field.label.toLowerCase()}...`}</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </SelectWithChevron>
        ) : (
          <input
            id={id}
            type="text"
            {...registration}
            className={inputClass}
            placeholder={`${field.label} ID (or fetch)`}
          />
        )}
        <button
          type="button"
          onClick={onFetchTargets}
          disabled={fetching}
          className={`${btnSecondary} bg-muted hover:bg-muted/80 whitespace-nowrap`}
        >
          {fetching ? 'Fetching...' : 'Fetch'}
        </button>
      </div>
      {error && <p className="text-sm text-destructive mt-1">{error.message}</p>}
      {fetchError && <p className="text-sm text-destructive mt-1">{fetchError}</p>}
    </div>
  );
}

function PathMappingsField({ form, field }: { form: ConnectorForm; field: ConnectorSettingsField }) {
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'settings.pathMappings' });
  return (
    <div className="sm:col-span-2">
      <label className="block text-sm font-medium mb-2">{field.label}</label>
      <p className="text-sm text-muted-foreground mb-2">
        Map narratorr library paths to the path the media server sees. Docker/LAN servers usually need an explicit mapping.
      </p>
      <div className="space-y-2">
        {fields.map((row, index) => (
          <div key={row.id} className="flex gap-2 items-center">
            <input
              type="text"
              {...form.register(`settings.pathMappings.${index}.localPath`)}
              className={inputClass}
              placeholder="/library/audiobooks"
            />
            <span className="text-muted-foreground">→</span>
            <input
              type="text"
              {...form.register(`settings.pathMappings.${index}.serverPath`)}
              className={inputClass}
              placeholder="/data/audiobooks"
            />
            <button
              type="button"
              onClick={() => remove(index)}
              className={`${btnSecondary} bg-muted hover:bg-muted/80 whitespace-nowrap`}
              aria-label="Remove path mapping"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => append({ localPath: '', serverPath: '' })}
        className={`${btnSecondary} bg-muted hover:bg-muted/80 mt-2`}
      >
        Add Mapping
      </button>
    </div>
  );
}

function ToggleField({ form, field }: { form: ConnectorForm; field: ConnectorSettingsField }) {
  return (
    <div className="sm:col-span-2">
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          {...form.register(settingsPath(field.key))}
          className="w-5 h-5 rounded border-border text-primary focus:ring-primary focus:ring-offset-0"
        />
        <span className="text-sm font-medium">{field.label}</span>
      </label>
    </div>
  );
}
