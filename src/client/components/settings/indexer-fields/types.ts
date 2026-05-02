import type { UseFormRegister, FieldErrors, UseFormWatch, UseFormSetValue } from 'react-hook-form';
import type { CreateIndexerFormData } from '../../../../shared/schemas.js';
import type { IndexerType } from '../../../../shared/indexer-registry.js';

export interface IndexerFieldsProps {
  selectedType: IndexerType;
  register: UseFormRegister<CreateIndexerFormData>;
  errors: FieldErrors<CreateIndexerFormData>;
  watch?: UseFormWatch<CreateIndexerFormData>;
  setValue?: UseFormSetValue<CreateIndexerFormData>;
  prowlarrManaged?: boolean;
  formTestResult?: { success: boolean; metadata?: Record<string, unknown>; ip?: string } | null;
  indexerId?: number;
}

export type FieldComponent = (props: Pick<IndexerFieldsProps, 'register' | 'errors' | 'watch' | 'setValue' | 'formTestResult' | 'indexerId'> & { selectedType: IndexerType; prowlarrManaged?: boolean }) => React.JSX.Element;
