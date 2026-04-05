import type { DownloadClient, TestResult } from '@/lib/api';
import { SettingsCardShell, type IdTestResult } from './SettingsCardShell';
import { DownloadClientForm } from './DownloadClientForm';
import type { CreateDownloadClientFormData } from '../../../shared/schemas.js';
import { DOWNLOAD_CLIENT_REGISTRY } from '../../../shared/download-client-registry.js';

const IMPLEMENTED_TYPES = Object.keys(DOWNLOAD_CLIENT_REGISTRY);

interface DownloadClientCardProps {
  client?: DownloadClient;
  mode: 'view' | 'edit' | 'create';
  onEdit?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  onSubmit: (data: CreateDownloadClientFormData) => void;
  onFormTest: (data: CreateDownloadClientFormData) => void;
  onTest?: (id: number) => void;
  isPending?: boolean;
  testingId?: number | null;
  testResult?: IdTestResult | null;
  testingForm?: boolean;
  formTestResult?: TestResult | null;
  animationDelay?: string;
  inModal?: boolean;
}

function viewSubtitle(client: DownloadClient): string {
  const meta = DOWNLOAD_CLIENT_REGISTRY[client.type];
  if (meta) return meta.viewSubtitle(client.settings as Record<string, unknown>);
  return client.type;
}

export function DownloadClientCard(props: DownloadClientCardProps) {
  const { client, mode, onEdit, onCancel, onDelete, onSubmit, onFormTest, onTest, isPending, testingId, testResult, testingForm, formTestResult, animationDelay, inModal } = props;

  if (mode === 'view' && client) {
    const notImpl = !IMPLEMENTED_TYPES.includes(client.type);
    return (
      <SettingsCardShell
        name={client.name} subtitle={viewSubtitle(client)} enabled={client.enabled} itemId={client.id}
        onEdit={onEdit} onTest={onTest} onDelete={onDelete} testingId={testingId} testResult={testResult}
        testDisabled={notImpl} testDisabledTitle={notImpl ? 'Testing available for implemented adapter types' : undefined}
        animationDelay={animationDelay}
      />
    );
  }

  return (
    <DownloadClientForm
      client={client} mode={mode === 'edit' ? 'edit' : 'create'}
      onCancel={onCancel} onSubmit={onSubmit} onFormTest={onFormTest}
      isPending={isPending} testingForm={testingForm} formTestResult={formTestResult}
      inModal={inModal}
    />
  );
}
