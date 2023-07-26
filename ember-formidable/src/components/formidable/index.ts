import {
  restartableTask,
  TaskGenerator,
  TaskInstance,
} from 'ember-concurrency';
import { taskFor } from 'ember-concurrency-ts';
import { FunctionBasedModifier, modifier } from 'ember-modifier';
import _cloneDeep from 'lodash/cloneDeep';
import _isEmpty from 'lodash/isEmpty';
import _isNil from 'lodash/isNil';
import _set from 'lodash/set';
import { tracked, TrackedObject } from 'tracked-built-ins';

import { action, get } from '@ember/object';
import { inject as service } from '@ember/service';
import {
  dependencySatisfies,
  importSync,
  macroCondition,
} from '@embroider/macros';
import Component from '@glimmer/component';

import FormidableService from '../../services/formidable';

type TUpdateEvents = 'onChange' | 'onSubmit' | 'onBlur' | 'onFocus';
type Values = Record<string, any>;

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

type TFormidableErrors = Record<string, IFormidableError[]>;
interface IFormidableError {
  type: string;
  message: string;
  value: unknown;
}

interface IRollbackContext {
  keepError?: boolean;
  keepDirty?: boolean;
  defaultValue?: boolean;
}

interface ISetValueContext {
  shouldValidate?: boolean;
  shouldDirty?: boolean;
}
interface IFieldState {
  isDirty: boolean;
  isPristine: boolean;
  isInvalid: boolean;
  error?: object;
}

interface FormidableApi {
  values: Values;
  setValue: (
    key: string,
    value: string | boolean,
    context?: ISetValueContext,
  ) => void;
  getValue: (key: string) => unknown;
  getValues: () => unknown;
  getFieldState: (name: string) => IFieldState;
  fieldsState: Record<string, IFieldState>;
  register: FunctionBasedModifier<{
    Args: {
      Positional: [string];
      Named: RegisterOptions;
    };
    Element: HTMLInputElement;
  }>;
  onSubmit: (e: SubmitEvent) => TaskInstance<void>;
  validate: () => void;
  errors: TFormidableErrors;
  errorMessages: string[];
  setError: (key: string, value: string | IFormidableError) => void;
  clearError: (key: string) => void;
  clearErrors: () => void;
  rollback: (name?: string, context?: IRollbackContext) => void;
  defaultValues: Values;
  isSubmitted: boolean;
  isSubmitting: boolean;
  isValid: boolean;
  isValidating: boolean;
  invalidFields: Record<string, boolean>;
  isDirty: boolean;
  dirtyFields: Record<string, boolean>;
  isPristine: boolean;
}
interface IFormidable {
  serviceId?: string;
  values?: Values;
  validator?: Function;
  validatorOptions?: any;
  onValuesChanged?: (data: Values, api: FormidableApi) => void;
  onChange?: (event: Event, api: FormidableApi) => void;
  onSubmit?: (event: SubmitEvent, api: FormidableApi) => void;
  updateEvents?: TUpdateEvents[];
  shouldUseNativeValidation?: boolean;
}

interface RegisterOptions {
  // HTML Input attributes
  disabled?: boolean;
  required?: boolean;
  maxLength?: number;
  minLength?: number;
  max?: number;
  min?: number;
  pattern?: RegExp | string;

  // Format
  valueAsNumber?: boolean;
  valueAsDate?: boolean;
  valueFormat: (value: string) => unknown;

  // Handlers
  onChange?: (event: Event, api: FormidableApi) => void;
  onBlur?: (event: Event, api: FormidableApi) => void;
  onFocus?: (event: Event, api: FormidableApi) => void;
}

export default class Formidable extends Component<IFormidable> {
  @service formidable!: FormidableService;

  // --- VALUES
  @tracked
  values: Values = this.isModel
    ? this.args.values ?? {}
    : new TrackedObject(this.args.values ?? {});

  // --- SUBMIT
  @tracked isSubmitSuccessful: boolean | undefined = undefined;
  @tracked isSubmitted = false;
  @tracked submitCount = 0;

  // --- VALIDATION
  @tracked validations: Record<string, object> = new TrackedObject({});

  // --- ERRORS
  @tracked errors: TFormidableErrors = new TrackedObject({});

  // --- DIRTY FIELDS
  @tracked dirtyFields: Record<string, boolean> = new TrackedObject({});

  // --- PARSER
  parsers: Record<
    string,
    Pick<RegisterOptions, 'valueAsDate' | 'valueAsNumber' | 'valueFormat'>
  > = {};

  validator = this.args.validator;

  // --- ROLLBACK
  rollbackValues: Values = this.isModel
    ? this.args.values ?? {}
    : _cloneDeep(this.args.values ?? {});

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
  }

  get isValid() {
    return _isEmpty(this.errors);
  }
  get invalidFields(): Record<string, boolean> {
    return Object.keys(this.errors).reduce(
      (invalid: Record<string, boolean>, key) => {
        return _set(invalid, key, true);
      },
      {},
    );
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
        return _set(obj, key, value);
      }, {});
    }
  }

  get fieldsState(): Record<string, IFieldState> {
    return Object.keys(this.values).reduce((state, key) => {
      const isDirty = this.dirtyFields[key] ?? false;
      const isPristine = !isDirty;
      const error = this.errors[key];
      const isInvalid = !_isEmpty(error);

      return _set(state, key, { isDirty, isPristine, isInvalid, error });
    }, {});
  }

  get api(): FormidableApi {
    return {
      values: this.parsedValues,
      setValue: this.setValue,
      getValue: this.getValue,
      getValues: this.getValues,
      getFieldState: this.getFieldState,
      fieldsState: this.fieldsState,
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
      isValid: this.isValid,
      isValidating: this.isValidating,
      invalidFields: this.invalidFields,
      isDirty: this.isDirty,
      dirtyFields: this.dirtyFields,
      isPristine: this.isPristine,
    };
  }

  constructor(owner: any, args: IFormidable) {
    super(owner, args);
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
    name?: string,
    { keepError, keepDirty, defaultValue }: IRollbackContext = {},
  ) {
    if (name) {
      this.values[name] =
        defaultValue ?? this.rollbackValues[name] ?? undefined;
      if (!keepError) {
        delete this.errors[name];
      }
      if (!keepDirty) {
        delete this.dirtyFields[name];
      }
    } else {
      this.values = this.isModel
        ? this.rollbackValues
        : new TrackedObject(_cloneDeep(this.rollbackValues));

      if (!keepError) {
        this.errors = new TrackedObject({});
      }
      if (!keepDirty) {
        this.dirtyFields = new TrackedObject({});
      }
      this.isSubmitted = false;
    }
  }

  @action
  getFieldState(name: string): IFieldState {
    const isDirty = this.dirtyFields[name] ?? false;
    const isPristine = !isDirty;
    const error = this.errors[name];
    const isInvalid = !_isEmpty(error);

    return { isDirty, isPristine, isInvalid, error };
  }

  @action
  getValue(key: string) {
    if (
      this.isModel &&
      this.parsedValues['relationshipFor']?.(key)?.meta?.kind == 'belongsTo'
    ) {
      return this.parsedValues['belongsTo'](key).value();
    }

    if (this.isModel) {
      return this.parsedValues[key];
    }
    return get(this.parsedValues, key);
  }

  @action
  getValues() {
    return this.parsedValues;
  }

  @action
  setValue(
    key: string,
    value: string | boolean,
    { shouldValidate, shouldDirty }: ISetValueContext = {},
  ) {
    if (this.isModel) {
      let _value: string | number | Date | boolean = value;
      if (this.parsers[key]) {
        const { valueAsNumber, valueAsDate } = this.parsers[key]!;
        if (valueAsNumber) {
          _value = +value;
        }
        if (valueAsDate) {
          _value = new Date(`${value}`);
        }
      }

      this.values['set'](key, _value);
    } else {
      this.values[key] = value;
    }
    if (shouldDirty) {
      this.dirtyFields[key] = true;
    }
    if (shouldValidate) {
      taskFor(this.validate).perform(key);
    }
  }

  @action
  setError(key: string, value: string | IFormidableError) {
    if (typeof value === 'string') {
      this.errors[key] = {
        //@ts-ignore
        messages: [...(this.errors[key]?.messages ?? []), value],
        //@ts-ignore
        type: this.errors[key]?.type ?? 'custom',
      };
    } else {
      this.errors[key] = [value];
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
  }

  // --- TASKS
  @restartableTask
  *validate(field?: string): TaskGenerator<void> {
    if (!this.validator) {
      return;
    }
    const validation: TFormidableErrors = yield this.validator(
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
  }

  @restartableTask
  *submit(event: SubmitEvent): TaskGenerator<void> {
    this.isSubmitted = true;
    this.submitCount += 1;

    try {
      event.preventDefault();
      if (this.updateEvents.includes('onSubmit')) {
        taskFor(this.validate).perform();
      }
      if (this.args.onSubmit) {
        return this.args.onSubmit(event, this.api);
      }

      if (this.updateEvents.includes('onSubmit') && this.args.onValuesChanged) {
        this.args.onValuesChanged(this.parsedValues, this.api);
      }

      this.isSubmitSuccessful = true;
    } catch {
      this.isSubmitSuccessful = false;
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
    }
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
      [name]: [string],
      {
        disabled,
        required,
        maxLength,
        minLength,
        max,
        min,
        pattern,
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

      if (!isFormInput) {
        setAttribute(DATA_NAME, name);
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
        setAttribute('name', name);
        const value = this.getValue(name);
        if (isCheckbox) {
          input.checked = value ?? false;
        } else if (isRadio) {
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
      }

      // PARSERS
      this.parsers[name] = { valueAsNumber, valueAsDate, valueFormat };

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
        this.setValue(
          name,
          (event.target as HTMLInputElement)[isCheckbox ? 'checked' : 'value'],
        );

        if (onChange) {
          return onChange(event, this.api);
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
          return onBlur(event, this.api);
        }
        if (this.updateEvents.includes('onBlur') && this.args.onValuesChanged) {
          this.args.onValuesChanged(this.parsedValues, this.api);
        }
      };

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
          return onFocus(event, this.api);
        }

        if (
          this.updateEvents.includes('onFocus') &&
          this.args.onValuesChanged
        ) {
          this.args.onValuesChanged(this.parsedValues, this.api);
        }
      };

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
