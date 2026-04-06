import type { UseFormRegister, FieldErrors } from 'react-hook-form';
import type { CreateNotifierFormData } from '../../../shared/schemas.js';
import { NOTIFIER_FIELD_COMPONENTS } from './notifier-fields/index.js';

interface NotifierFieldsProps {
  selectedType: string;
  register: UseFormRegister<CreateNotifierFormData>;
  errors: FieldErrors<CreateNotifierFormData>;
}

export function NotifierFields({ selectedType, register, errors }: NotifierFieldsProps) {
  const Fields = NOTIFIER_FIELD_COMPONENTS[selectedType];
  if (!Fields) return null;
  return <Fields register={register} errors={errors} />;
}
