import { INDEXER_FIELD_COMPONENTS, UseProxyField, type IndexerFieldsProps } from './indexer-fields/index.js';

export type { IndexerFieldsProps } from './indexer-fields/index.js';

export function IndexerFields({ selectedType, register, errors, watch, setValue, prowlarrManaged, formTestResult, indexerId }: IndexerFieldsProps) {
  const Component = INDEXER_FIELD_COMPONENTS[selectedType];
  if (!Component) return null;
  return (
    <>
      <Component
        register={register}
        errors={errors}
        selectedType={selectedType}
        {...(watch !== undefined && { watch })}
        {...(setValue !== undefined && { setValue })}
        {...(prowlarrManaged !== undefined && { prowlarrManaged })}
        {...(formTestResult !== undefined && { formTestResult })}
        {...(indexerId !== undefined && { indexerId })}
      />
      <UseProxyField register={register} {...(watch !== undefined && { watch })} />
    </>
  );
}
