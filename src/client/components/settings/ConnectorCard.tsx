// Entity form for connector CRUD (not a settings-category patch), mirroring NotifierCard.
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Connector, TestResult } from '@/lib/api';
import { SettingsCardShell, type IdTestResult } from './SettingsCardShell';
import { ConnectorCardForm } from './ConnectorCardForm';
import { CONNECTOR_REGISTRY, CONNECTOR_TYPES } from '../../../shared/connector-registry.js';
import {
  createConnectorFormSchema,
  type CreateConnectorFormData,
} from '../../../shared/schemas.js';

interface ConnectorCardProps {
  connector?: Connector;
  mode: 'view' | 'edit' | 'create';
  onEdit?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  onSubmit: (data: CreateConnectorFormData) => void;
  onFormTest: (data: CreateConnectorFormData) => void;
  onTest?: (id: number) => void;
  isPending?: boolean;
  testingId?: number | null;
  testResult?: IdTestResult | null;
  testingForm?: boolean;
  formTestResult?: TestResult | null;
  animationDelay?: string;
}

function settingsFromConnector(connector: Connector): CreateConnectorFormData['settings'] {
  const meta = CONNECTOR_REGISTRY[connector.type];
  const defaults = meta?.defaultSettings ?? {};
  const ownKeys = new Set(Object.keys(defaults));
  const result: Record<string, unknown> = { ...defaults };
  // Overlay only non-null stored values belonging to this type. Connector
  // defaultSettings keys ≡ the strict per-type schema keys (pinned by the
  // schema-alignment test), so this never drops a valid key while keeping stale
  // foreign keys out of the strict server schema.
  for (const [key, val] of Object.entries(connector.settings)) {
    if (val != null && ownKeys.has(key)) result[key] = val;
  }
  return result as CreateConnectorFormData['settings'];
}

function viewSubtitle(connector: Connector): string {
  const meta = CONNECTOR_REGISTRY[connector.type];
  if (!meta) return connector.type;
  return meta.viewSubtitle(connector.settings);
}

const defaultValues: CreateConnectorFormData = {
  name: '',
  type: CONNECTOR_TYPES[0],
  enabled: true,
  settings: CONNECTOR_REGISTRY[CONNECTOR_TYPES[0]].defaultSettings,
};

export function ConnectorCard(props: ConnectorCardProps) {
  const {
    connector, mode, onEdit, onCancel, onDelete, onSubmit, onFormTest,
    onTest, isPending, testingId, testResult, testingForm, formTestResult, animationDelay,
  } = props;

  const form = useForm<CreateConnectorFormData>({
    resolver: zodResolver(createConnectorFormSchema),
    defaultValues: connector
      ? {
          name: connector.name,
          type: connector.type,
          enabled: connector.enabled,
          settings: settingsFromConnector(connector),
        }
      : defaultValues,
  });
  const { reset, setValue } = form;

  // eslint-disable-next-line react-hooks/incompatible-library
  const selectedType = form.watch('type');

  useEffect(() => {
    if (mode === 'edit' && connector) {
      reset({
        name: connector.name,
        type: connector.type,
        enabled: connector.enabled,
        settings: settingsFromConnector(connector),
      });
    } else if (mode === 'create') {
      reset(defaultValues);
    }
  }, [mode, connector, reset]);

  useEffect(() => {
    if (mode === 'create') {
      const meta = CONNECTOR_REGISTRY[selectedType];
      setValue('settings', meta?.defaultSettings || CONNECTOR_REGISTRY[CONNECTOR_TYPES[0]].defaultSettings);
    }
  }, [selectedType, mode, setValue]);

  if (mode === 'view' && connector) {
    const typeLabel = CONNECTOR_REGISTRY[connector.type]?.label || connector.type;
    return (
      <SettingsCardShell
        name={connector.name}
        subtitle={`${typeLabel} — ${viewSubtitle(connector)}`}
        enabled={connector.enabled}
        itemId={connector.id}
        onEdit={onEdit}
        onTest={onTest}
        onDelete={onDelete}
        testingId={testingId}
        testResult={testResult}
        testResultTexts={{ success: 'Connected!', failure: 'Failed' }}
        animationDelay={animationDelay}
      />
    );
  }

  return (
    <ConnectorCardForm
      form={form}
      isEdit={mode === 'edit'}
      selectedType={selectedType}
      editingId={connector?.id}
      onSubmit={onSubmit}
      onFormTest={onFormTest}
      onCancel={onCancel}
      isPending={isPending}
      testingForm={testingForm}
      formTestResult={formTestResult}
    />
  );
}
