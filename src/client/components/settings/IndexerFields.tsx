import { INDEXER_FIELD_COMPONENTS, UseProxyField, type IndexerFieldsProps } from './indexer-fields/index.js';

export type { IndexerFieldsProps } from './indexer-fields/index.js';

export function IndexerFields({ selectedType, register, errors, watch, setValue, prowlarrManaged, formTestResult, indexerId }: IndexerFieldsProps) {
  const Component = INDEXER_FIELD_COMPONENTS[selectedType];
  if (!Component) return null;
  return (
    <>
      <Component register={register} errors={errors} watch={watch} setValue={setValue} selectedType={selectedType} prowlarrManaged={prowlarrManaged} formTestResult={formTestResult} indexerId={indexerId} />
      <UseProxyField register={register} watch={watch} />
    </>
  );
}
