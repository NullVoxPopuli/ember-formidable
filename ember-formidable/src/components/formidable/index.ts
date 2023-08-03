import {
  restartableTask,
  TaskGenerator,
  TaskInstance
} from 'ember-concurrency';
import { taskFor } from 'ember-concurrency-ts';
import { FunctionBasedModifier, modifier } from 'ember-modifier';
import _cloneDeep from 'lodash/cloneDeep';
import _isEmpty from 'lodash/isEmpty';
import _isNil from 'lodash/isNil';
import _isObject from 'lodash/isObject';
import _set from 'lodash/set';
import { tracked, TrackedObject } from 'tracked-built-ins';

import { action, get } from '@ember/object';
import { inject as service } from '@ember/service';
import {
  dependencySatisfies,
  importSync,
  macroCondition
} from '@embroider/macros';
import Component from '@glimmer/component';

import FormidableService from '../../services/formidable';

type UpdateEvents = 'onChange' | 'onSubmit' | 'onBlur' | 'onFocus';

type GenericObject = Record<string, any>;

let Model: Function | undefined;

if (macroCondition(dependencySatisfies('ember-data', '*'))) {
  Model = (importSync('@ember-data/model') as { default: Function }).default;
}

const DATA_NAME = 'data-formidable-name';

const inputUtils = (input: HTMLInputElement) => {
  return {
    setAttribute: (
      attribute: string,
      value: string | number | undefined | boolean,
    ) => {
      if (_isNil(value) || !`${value}`.trim()) {
        input.removeAttribute(attribute);
      } else {
        input.setAttribute(attribute, `${value}`);
      }
    },
    isFormInput: ['INPUT', 'SELECT', 'TEXTAREA'].includes(input.tagName),
    isInput: input.tagName === 'INPUT',
    isTextarea: input.tagName === 'TEXTAREA',
    isSelect: input.tagName === 'SELECT',
    isCheckbox: input.type === 'checkbox',
    isRadio: input.type === 'radio',
  };
};

type FormidableErrors<
  T extends string | number | symbol = string | number | symbol,
> = Record<T, FormidableError[]>;

type DirtyFields<Values extends GenericObject = GenericObject> = Record<
  keyof Values,
  boolean
>;

type InvalidFields<Values extends GenericObject = GenericObject> = Record<
  keyof Values,
  boolean
>;

type Parser<Values extends GenericObject = GenericObject> = Record<
  keyof Values,
  Pick<
    RegisterOptions,
    'valueAsDate' | 'valueAsNumber' | 'valueFormat' | 'valueAsBoolean'
  >
>;
interface FormidableError {
  type: string;
  message: string;
  value: unknown;
}

interface RollbackContext {
  keepError?: boolean;
  keepDirty?: boolean;
  defaultValue?: boolean;
}

interface SetValueContext {
  shouldValidate?: boolean;
  shouldDirty?: boolean;
}
interface FieldState {
  isDirty: boolean;
  isPristine: boolean;
  isInvalid: boolean;
  error?: object;
}

interface FormidableApi<Values extends GenericObject = GenericObject> {
  values: Values;
  setValue: (
    key: string,
    value: string | boolean,
    context?: SetValueContext,
  ) => void;
  getValue: (key: keyof Values) => unknown;
  getValues: () => Values;
  getFieldState: (name: string) => FieldState;
  register: FunctionBasedModifier<{
    Args: {
      Positional: [keyof Values];
      Named: RegisterOptions;
    };
    Element: HTMLInputElement;
  }>;
  onSubmit: (e: SubmitEvent) => TaskInstance<void>;
  validate: () => void;
  errors: FormidableErrors<keyof Values>;
  errorMessages: string[];
  setError: (key: string, value: string | FormidableError) => void;
  clearError: (key: string) => void;
  clearErrors: () => void;
  rollback: (name?: string, context?: RollbackContext) => void;
  defaultValues: Values;
  isSubmitted: boolean;
  isSubmitting: boolean;
  isSubmitSuccessful: boolean | undefined;
  submitCount: number;
  isValid: boolean;
  isInvalid: boolean;
  isValidating: boolean;
  invalidFields: Record<keyof Values, boolean>;
  isDirty: boolean;
  dirtyFields: Record<keyof Values, boolean>;
  isPristine: boolean;
}
interface FormidableArgs<Values extends GenericObject = GenericObject> {
  serviceId?: string;
  values?: Values;
  validator?: Function;
  validatorOptions?: any;
  onValuesChanged?: (data: Values, api: FormidableApi<Values>) => void;
  onChange?: (event: Event, api: FormidableApi<Values>) => void;
  onSubmit?: (event: SubmitEvent, api: FormidableApi<Values>) => void;
  updateEvents?: UpdateEvents[];
  shouldUseNativeValidation?: boolean;
}

interface RegisterOptions<Values extends GenericObject = GenericObject> {
  // HTML Input attributes
  disabled?: boolean;
  required?: boolean;
  maxLength?: number;
  minLength?: number;
  max?: number;
  min?: number;
  pattern?: RegExp | string;

  // Format
  valueAsBoolean?: boolean;
  valueAsNumber?: boolean;
  valueAsDate?: boolean;
  valueFormat: (value: unknown) => any;

  // Handlers
  onChange?: (event: Event, api: FormidableApi<Values>) => void;
  onBlur?: (event: Event, api: FormidableApi<Values>) => void;
  onFocus?: (event: Event, api: FormidableApi<Values>) => void;
}

export default class Formidable<
  Values extends GenericObject = GenericObject,
> extends Component<FormidableArgs<Values>> {
  @service formidable!: FormidableService;

  // --- VALUES
  @tracked
  values: Values = this.isModel
    ? this.args.values ?? ({} as Values)
    : (new TrackedObject(this.args.values ?? {}) as Values);

  // --- SUBMIT
  @tracked isSubmitSuccessful: boolean | undefined = undefined;
  @tracked isSubmitted = false;
  @tracked submitCount = 0;

  // --- VALIDATION
  @tracked validations: Record<keyof Values, object> = new TrackedObject(
    {},
  ) as Record<keyof Values, object>;

  // --- ERRORS
  @tracked errors: FormidableErrors = new TrackedObject({});

  // --- DIRTY FIELDS
  @tracked dirtyFields: DirtyFields<Values> = new TrackedObject(
    {},
  ) as DirtyFields<Values>;

  // --- PARSER
  parsers: Parser<Values> = {} as Parser<Values>;

  validator = this.args.validator;

  // --- ROLLBACK
  rollbackValues: Values;

  // --- UTILS
  get isModel() {
    if (!Model) {
      return false;
    }
    return this.args.values instanceof Model;
  }

  // --- STATES
  get isSubmitting(): boolean {
    return taskFor(this.submit).isRunning;
  }

  get isValidating() {
    return taskFor(this.validate).isRunning;
  } // !!TEST

  get isValid() {
    return _isEmpty(this.errors);
  }

  get isInvalid() {
    return !this.isValid;
  }

  get invalidFields(): InvalidFields<Values> {
    return Object.keys(this.errors).reduce(
      (invalid: Record<string, boolean>, key) => {
        return _set(invalid, key, true);
      },
      {},
    ) as InvalidFields<Values>;
  }

  get errorMessages() {
    return Object.values(this.errors)
      .flat()
      .map((err) => err.message);
  }

  get isDirty() {
    return !this.isPristine;
  }

  get isPristine() {
    return _isEmpty(this.dirtyFields);
  }

  get updateEvents() {
    return this.args.updateEvents ?? ['onSubmit'];
  }

  get parsedValues(): Values {
    if (this.isModel) {
      return this.values;
    } else {
      return Object.entries(this.values).reduce((obj, [key, value]) => {
        if (!this.parsers[key]) {
          return _set(obj, key, value);
        }
        if (this.parsers[key]?.valueFormat) {
          return _set(obj, key, this.parsers[key]?.valueFormat(value));
        }
        if (this.parsers[key]?.valueAsNumber) {
          return _set(obj, key, +value);
        }
        if (this.parsers[key]?.valueAsDate) {
          return _set(obj, key, new Date(value));
        }
        if (this.parsers[key]?.valueAsBoolean) {
          return _set(obj, key, Boolean(value));
        }
        return _set(obj, key, value);
      }, {}) as Values;
    }
  }

  get api(): FormidableApi<Values> {
    return {
      values: this.parsedValues,
      setValue: this.setValue,
      getValue: this.getValue,
      getValues: this.getValues,
      getFieldState: this.getFieldState,
      register: this.register,
      onSubmit: (e: SubmitEvent) => taskFor(this.submit).perform(e),
      validate: () => taskFor(this.validate).perform(),
      errors: this.errors,
      errorMessages: this.errorMessages,
      setError: this.setError,
      clearError: this.clearError,
      clearErrors: this.clearErrors,
      rollback: this.rollback,
      defaultValues: this.rollbackValues,
      isSubmitted: this.isSubmitted,
      isSubmitting: this.isSubmitting,
      isSubmitSuccessful: this.isSubmitSuccessful,
      submitCount: this.submitCount,
      isValid: this.isValid,
      isInvalid: this.isInvalid,
      isValidating: this.isValidating,
      invalidFields: this.invalidFields,
      isDirty: this.isDirty,
      dirtyFields: this.dirtyFields,
      isPristine: this.isPristine,
    };
  }

  constructor(owner: any, args: FormidableArgs<Values>) {
    super(owner, args);
    if (this.isModel) {
      const { values = {} as Values } = this.args;
      const rollbackValues: Values = {} as Values;
      (values as Values)['eachAttribute']((key: keyof Values) => {
        const value = get(values, key);
        if (_isObject(value)) {
          rollbackValues[key] = _cloneDeep(value);
        } else {
          rollbackValues[key] = value;
        }
      });
      this.rollbackValues = rollbackValues;
    } else {
      this.rollbackValues = _cloneDeep(this.args.values ?? {}) as Values;
    }
    if (this.args.serviceId) {
      this.formidable._register(this.args.serviceId, () => this.api);
    }
  }

  willDestroy(): void {
    if (this.args.serviceId) {
      this.formidable._unregister(this.args.serviceId);
    }
  }

  // --- STATES HANDLERS

  @action
  rollback(
    name?: keyof Values,
    { keepError, keepDirty, defaultValue }: RollbackContext = {},
  ) {
    if (name) {
      this.values[name] = (defaultValue ??
        this.rollbackValues[name] ??
        undefined) as Values[keyof Values];
      if (!keepError) {
        delete this.errors[name];
      }
      if (!keepDirty) {
        delete this.dirtyFields[name as keyof Values];
      }
    } else {
      if (this.isModel) {
        Object.entries(this.rollbackValues).forEach(([key, value]) => {
          this.values['set'](key, value);
        });
      } else {
        this.values = new TrackedObject(_cloneDeep(this.rollbackValues));
      }

      if (!keepError) {
        this.errors = new TrackedObject({});
      }
      if (!keepDirty) {
        this.dirtyFields = new TrackedObject({}) as DirtyFields<Values>;
      }
      this.isSubmitted = false;
    }
  }

  @action
  getFieldState(name: string): FieldState {
    const isDirty = this.dirtyFields[name] ?? false;
    const isPristine = !isDirty;
    const error = this.errors[name];
    const isInvalid = !_isEmpty(error);

    return { isDirty, isPristine, isInvalid, error };
  }

  @action
  getValue(key: keyof Values) {
    if (
      this.isModel &&
      this.parsedValues['relationshipFor']?.(key)?.meta?.kind == 'belongsTo'
    ) {
      return this.parsedValues['belongsTo'](key).value();
    }

    return get(this.parsedValues, key);
  }

  @action
  getValues() {
    return this.parsedValues;
  }

  @action
  setValue(
    key: keyof Values,
    value: string | boolean | undefined,
    { shouldValidate, shouldDirty }: SetValueContext = {},
  ) {
    if (this.isModel) {
      let _value: string | number | Date | boolean | undefined = value;
      if (this.parsers[key]) {
        const { valueAsNumber, valueAsDate, valueAsBoolean, valueFormat } =
          this.parsers[key]!;
        if (valueAsNumber) {
          _value = +(value ?? '');
        } else if (valueAsDate) {
          _value = new Date(`${value}`);
        } else if (valueAsBoolean) {
          _value = Boolean(value);
        } else if (valueFormat) {
          _value = valueFormat(_value);
        }
      } // !!TEST + TODO: Find a better way to squash both values and models

      this.values['set'](key, _value);
    } else {
      this.values[key] = value as Values[keyof Values];
    }
    if (shouldDirty) {
      this.dirtyFields[key] = true;
    } // !!TEST
    if (shouldValidate) {
      taskFor(this.validate).perform(key);
    } // !!TEST
  }

  @action
  setError(key: string, error: string | FormidableError) {
    if (typeof error === 'string') {
      this.errors[key] = [
        ...(this.errors[key] ?? []),
        {
          message: error as string,
          type: 'custom',
          value: undefined,
        },
      ];
    } else {
      this.errors[key] = [
        ...(this.errors[key] ?? []),
        {
          message: error.message,
          type: error.type ?? 'custom',
          value: error.value ?? undefined,
        },
      ];
    }
  }

  @action
  clearError(key: string) {
    this.errors = _set(this.errors, key, undefined);
  }

  @action
  clearErrors() {
    this.errors = new TrackedObject({});
  }

  @action
  setFocus(name: string) {
    (
      (document.querySelector(`[name="${name}"]`) as HTMLInputElement | null) ??
      (document.querySelector(`[${DATA_NAME}="${name}"]`) as HTMLInputElement)
    ).focus();

    if (this.updateEvents.includes('onFocus')) {
      taskFor(this.validate).perform();
    }
  } // !!TEST

  // --- TASKS
  @restartableTask
  *validate(field?: keyof Values): TaskGenerator<void> {
    if (!this.validator) {
      return;
    }
    const validation: FormidableErrors = yield this.validator(
      this.parsedValues,
      {
        validations: this.validations,
        ...this.args.validatorOptions,
      },
    );

    if (field) {
      this.errors = _set(this.errors, field, get(validation, field));
    } else {
      this.errors = new TrackedObject(validation);
    }
  } // !!TEST

  @restartableTask
  *submit(event: SubmitEvent): TaskGenerator<void> {
    this.isSubmitted = true;
    this.submitCount += 1;

    event.preventDefault();

    if (this.updateEvents.includes('onSubmit')) {
      yield taskFor(this.validate).perform();
    }

    this.isSubmitSuccessful = this.isValid;

    if (!this.isSubmitSuccessful) {
      return;
    }

    if (this.args.onSubmit) {
      return this.args.onSubmit(event, this.api);
    } // !!TEST

    if (this.updateEvents.includes('onSubmit') && this.args.onValuesChanged) {
      this.args.onValuesChanged(this.parsedValues, this.api);
    }
  }

  // --- EVENT HANLDERS

  @action
  onChange(event: InputEvent) {
    if (this.updateEvents.includes('onChange')) {
      taskFor(this.validate).perform();
    }
    if (this.args.onChange) {
      return this.args.onChange(event, this.api);
    } // !!TEST
    if (!event.target) {
      throw new Error(
        'FORMIDABLE - No input element found when value got set.',
      );
    }
    const target = event.target as HTMLInputElement;
    this.setValue(target.name, target.value);

    if (this.updateEvents.includes('onChange') && this.args.onValuesChanged) {
      this.args.onValuesChanged(this.parsedValues, this.api);
    }
  }

  register = modifier(
    (
      input: HTMLInputElement,
      [name]: [keyof Values],
      {
        disabled,
        required,
        maxLength,
        minLength,
        max,
        min,
        pattern,
        valueAsBoolean,
        valueAsNumber,
        valueAsDate,
        valueFormat,
        onChange,
        onBlur,
        onFocus,
      }: RegisterOptions,
    ) => {
      const {
        setAttribute,
        isFormInput,
        isInput,
        isCheckbox,
        isRadio,
        isTextarea,
        isSelect,
      } = inputUtils(input);

      // PARSERS
      this.parsers[name] = {
        valueAsNumber,
        valueAsDate,
        valueAsBoolean,
        valueFormat,
      };

      if (!isFormInput) {
        setAttribute(DATA_NAME, name as string);
        return;
      }

      // ATTRIBUTES

      if (isInput && input.type === 'number') {
        setAttribute('min', min);
        setAttribute('max', max);
      } else if (isInput || isTextarea) {
        setAttribute('minlength', minLength);
        setAttribute('maxlength', maxLength);
        setAttribute('disabled', disabled);
        setAttribute('required', required);

        if (isInput) {
          const strPattern =
            typeof pattern === 'string' ? pattern : pattern?.toString();
          setAttribute('pattern', strPattern);
        }
      }

      if (isFormInput) {
        setAttribute('name', name as string);
        const value = this.getValue(name);
        if (isRadio || isCheckbox) {
          input.checked = input.value === value;
        } else if (isInput || isTextarea) {
          input.value = value ?? '';
        }
      }

      // VALIDATIONS
      if (this.args.shouldUseNativeValidation) {
        this.validations[name] = {
          min,
          max,
          minLength,
          maxLength,
          disabled,
          required,
        };
      } // USEFUL?

      // HANDLERS
      const handleChange = async (event: Event) => {
        if (!event.target) {
          throw new Error(
            'FORMIDABLE - No input element found when value got set.',
          );
        }
        this.dirtyFields[name] = true;
        if (this.updateEvents.includes('onChange')) {
          await taskFor(this.validate).perform();
        }
        this.setValue(name, (event.target as HTMLInputElement).value);

        if (onChange) {
          return onChange(event, this.api as FormidableApi<GenericObject>); // !!TEST
        }
        if (
          this.updateEvents.includes('onChange') &&
          this.args.onValuesChanged
        ) {
          this.args.onValuesChanged(this.parsedValues, this.api);
        }
      };

      const handleBlur = async (event: Event) => {
        if (!event.target) {
          throw new Error(
            'FORMIDABLE - No input element found when value got set.',
          );
        }
        if (this.updateEvents.includes('onBlur')) {
          await taskFor(this.validate).perform();
        }
        this.setValue(name, (event.target as HTMLInputElement).value);
        if (onBlur) {
          return onBlur(event, this.api as FormidableApi<GenericObject>); // !!TEST
        }
        if (this.updateEvents.includes('onBlur') && this.args.onValuesChanged) {
          this.args.onValuesChanged(this.parsedValues, this.api);
        }
      }; // !!TEST

      const handleFocus = async (event: Event) => {
        if (!event.target) {
          throw new Error(
            'FORMIDABLE - No input element found when value got set.',
          );
        }

        if (this.updateEvents.includes('onFocus')) {
          await taskFor(this.validate).perform();
        }

        this.setValue(name, (event.target as HTMLInputElement).value);
        if (onFocus) {
          return onFocus(event, this.api as FormidableApi<GenericObject>);
        }

        if (
          this.updateEvents.includes('onFocus') &&
          this.args.onValuesChanged
        ) {
          this.args.onValuesChanged(this.parsedValues, this.api);
        }
      }; // !!TEST

      const preventDefault = (e: Event) => {
        if (!this.args.shouldUseNativeValidation) {
          e.preventDefault();
        }
      };

      // EVENTS

      input.addEventListener(
        isInput || isSelect || isTextarea ? 'input' : 'change',
        handleChange,
      );
      input.addEventListener('invalid', preventDefault);

      if (onBlur || this.updateEvents.includes('onBlur')) {
        input.addEventListener('blur', handleBlur);
      }

      if (onFocus || this.updateEvents.includes('onFocus')) {
        input.addEventListener('focusin', handleFocus);
      }

      return () => {
        input.removeEventListener(
          isInput || isSelect || isTextarea ? 'input' : 'change',
          handleChange,
        );
        input.removeEventListener('invalid', preventDefault);

        if (onBlur || this.updateEvents.includes('onBlur')) {
          input.removeEventListener('blur', handleBlur);
        }
        if (onFocus || this.updateEvents.includes('onFocus')) {
          input.removeEventListener('focus', handleFocus);
        }
      };
    },
  );
}
