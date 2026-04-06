import type { FieldComponent } from './types.js';
import { AbbFields } from './abb-fields.js';
import { ApiFields } from './api-fields.js';
import { MamFields } from './mam-fields.js';

export { UseProxyField } from './use-proxy-field.js';
export type { IndexerFieldsProps, FieldComponent } from './types.js';

export const INDEXER_FIELD_COMPONENTS: Record<string, FieldComponent> = {
  abb: AbbFields,
  torznab: ApiFields,
  newznab: ApiFields,
  myanonamouse: MamFields,
};
