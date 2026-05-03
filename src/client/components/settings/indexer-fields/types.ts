import type { UseFormRegister, FieldErrors, UseFormWatch, UseFormSetValue } from 'react-hook-form';
import type { CreateIndexerFormData } from '../../../../shared/schemas.js';
import type { IndexerType } from '../../../../shared/indexer-registry.js';
import type { IndexerTestResult } from '../../../../core/indexers/types.js';

export interface IndexerFieldsProps {
  selectedType: IndexerType;
  register: UseFormRegister<CreateIndexerFormData>;
  errors: FieldErrors<CreateIndexerFormData>;
  watch?: UseFormWatch<CreateIndexerFormData> | undefined;
  setValue?: UseFormSetValue<CreateIndexerFormData> | undefined;
  prowlarrManaged?: boolean | undefined;
  formTestResult?: IndexerTestResult | null | undefined;
  indexerId?: number | undefined;
}

export type FieldComponent = (props: Pick<IndexerFieldsProps, 'register' | 'errors' | 'watch' | 'setValue' | 'formTestResult' | 'indexerId'> & { selectedType: IndexerType; prowlarrManaged?: boolean | undefined }) => React.JSX.Element;
