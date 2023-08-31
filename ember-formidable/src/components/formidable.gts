import Component from '@glimmer/component';
import { cached } from '@glimmer/tracking';
import { assert, warn } from '@ember/debug';
import { action, get } from '@ember/object';
import { inject as service } from '@ember/service';

import { modifier } from 'ember-modifier';
import _cloneDeep from 'lodash/cloneDeep';
import _isEmpty from 'lodash/isEmpty';
import _isEqual from 'lodash/isEqual';
import _set from 'lodash/set';
import _unset from 'lodash/unset';
import { tracked, TrackedObject } from 'tracked-built-ins';

import { formatValue, inputUtils, valueIfChecked } from '../-private/utils';

import type {
  DirtyFields,
  FieldState,
  FormidableApi,
  FormidableArgs,
  FormidableError,
  FormidableErrors,
  HandlerEvent,
  InvalidFields,
  NativeValidations,
  Parser,
  RegisterModifier,
  ResolverOptions,
  RollbackContext,
  SetContext,
  UnregisterContext,
} from '../index';
import type FormidableService from '../services/formidable';
import type { GenericObject, ValueKey } from '../types';
import type { FunctionBasedModifier } from 'ember-modifier';

const DATA_NAME = 'data-formidable-name';
const DATA_REQUIRED = 'data-formidable-required';
const DATA_DISABLED = 'data-formidable-disabled';

const UNREGISTERED_ATTRIBUTE = 'data-formidable-unregistered';

export interface FormidableSignature<
  Values extends GenericObject = GenericObject,
  ValidatorOptions extends GenericObject = GenericObject,
> {
  Element: HTMLElement;
  Args: FormidableArgs<Values, ValidatorOptions>;
  Blocks: {
    default: [parsedValues: Values, api: FormidableApi<Values>];
  };
}

export default class Formidable<
  Values extends GenericObject = GenericObject,
  ValidatorOptions extends GenericObject = GenericObject,
> extends Component<FormidableSignature<Values, ValidatorOptions>> {
  @service formidable!: FormidableService;

  // --- VALUES
  values: Values = new TrackedObject(_cloneDeep(this.args.values ?? {})) as Values;

  // --- SUBMIT
  @tracked isSubmitSuccessful: boolean | undefined = undefined;
  @tracked isSubmitted = false;
  @tracked isSubmitting = false;
  @tracked isValidating = false;

  @tracked submitCount = 0;

  @tracked nativeValidations: NativeValidations<Values> = {} as NativeValidations<Values>;

  // --- ERRORS
  errors: FormidableErrors = new TrackedObject({});

  // --- DIRTY FIELDS
  dirtyFields: DirtyFields<Values> = new TrackedObject({}) as DirtyFields<Values>;

  // --- PARSER
  parsers: Parser<Values> = {} as Parser<Values>;

  validator = this.args.validator;

  // --- ROLLBACK
  rollbackValues: Values = new TrackedObject(_cloneDeep(this.args.values ?? {}) as Values);

  // --- STATES

  get isValid(): boolean {
    return _isEmpty(this.errors);
  }

  get isInvalid(): boolean {
    return !this.isValid;
  }

  get invalidFields(): InvalidFields<Values> {
    return Object.keys(this.errors).reduce((invalid: Record<string, boolean>, key) => {
      return _set(invalid, key, true);
    }, {}) as InvalidFields<Values>;
  }

  get errorMessages(): string[] {
    return (
      Object.values(this.errors)
        .flat()
        // Useful after a clearError
        .filter(Boolean)
        .map((err) => {
          warn(
            `FORMIDABLE - We cannot find any error message. Are you sure it's in the right format? Here's what we received:
        ${typeof err === 'object' ? JSON.stringify(err) : err}`,
            Boolean(err && err.message),
            {
              id: 'ember-formidable.error-message-not-found',
            },
          );

          return err?.message;
        })
    );
  }

  get isDirty(): boolean {
    return !this.isPristine;
  }

  get isPristine(): boolean {
    return _isEmpty(this.dirtyFields);
  }

  get handleOn(): HandlerEvent[] {
    return this.args.handleOn ?? ['onSubmit'];
  }

  get validateOn(): HandlerEvent[] {
    return this.args.validateOn ?? ['onBlur', 'onSubmit'];
  }

  get revalidateOn(): HandlerEvent[] {
    return this.args.revalidateOn ?? ['onChange', 'onSubmit'];
  }

  get parsedValues(): Values {
    return Object.entries(this.values).reduce((obj, [key, value]) => {
      return _set(obj, key, formatValue(value, this.parsers[key as ValueKey<Values>]));
    }, {}) as Values;
  }

  @cached
  get api(): FormidableApi<Values> {
    return {
      values: this.parsedValues,
      setValue: async (
        field: ValueKey<Values>,
        value: string | boolean | undefined,
        context?: SetContext,
      ) => await this.setValue(field, value, context),
      getValue: this.getValue,
      getValues: this.getValues,
      getDefaultValue: this.getDefaultValue,
      getFieldState: this.getFieldState,
      register: this.register as FunctionBasedModifier<RegisterModifier<Values>>,
      unregister: this.unregister,
      onSubmit: async (e: SubmitEvent) => await this.submit(e),
      validate: async (field?: ValueKey<Values>) => await this.validate(field),
      errors: this.errors,
      errorMessages: this.errorMessages,
      setError: this.setError,
      clearError: this.clearError,
      clearErrors: this.clearErrors,
      rollback: this.rollback,
      rollbackInvalid: async (context?: RollbackContext) => await this.rollbackInvalid(context),
      setFocus: async (name: ValueKey<Values>, context?: SetContext) =>
        await this.setFocus(name, context),
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

  constructor(owner: any, args: FormidableArgs<Values, ValidatorOptions>) {
    super(owner, args);

    if (this.args.serviceId) {
      this.formidable._register(this.args.serviceId, () => this.api as FormidableApi);
    }
  }

  // eslint-disable-next-line ember/require-super-in-lifecycle-hooks
  willDestroy(): void {
    if (this.args.serviceId) {
      this.formidable._unregister(this.args.serviceId);
    }
  }

  // --- STATES HANDLERS

  @action
  rollback(
    field?: ValueKey<Values>,
    { keepError, keepDirty, defaultValue }: RollbackContext = {},
  ): void {
    if (field) {
      this.values[field] = (defaultValue ??
        this.rollbackValues[field] ??
        undefined) as Values[ValueKey<Values>];

      if (defaultValue) {
        this.rollbackValues[field] = defaultValue as Values[ValueKey<Values>];
      }

      if (!keepError) {
        _unset(this.errors, field);
      }

      if (!keepDirty) {
        _unset(this.dirtyFields, field);
      }
    } else {
      this.values = new TrackedObject(_cloneDeep(this.rollbackValues));

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
  async rollbackInvalid(context: RollbackContext = {}): Promise<void> {
    await this.validate();

    for (const field of Object.keys(this.invalidFields)) {
      this.rollback(field, context);
    }
  }

  @action
  getFieldState(name: ValueKey<Values>): FieldState {
    const isDirty = this.dirtyFields[name] ?? false;
    const isPristine = !isDirty;
    const error = this.errors[name];
    const isInvalid = !_isEmpty(error);

    return { isDirty, isPristine, isInvalid, error };
  }

  @action
  getValue(field: ValueKey<Values>): any {
    return get(this.parsedValues, field);
  }

  @action
  getValues(): Values {
    return this.parsedValues;
  }

  @action
  getDefaultValue(field: ValueKey<Values>): any {
    return get(this.rollbackValues, field);
  }

  @action
  setError(field: ValueKey<Values>, error: string | FormidableError): void {
    if (typeof error === 'string') {
      this.errors[field] = [
        ...(this.errors[field] ?? []),
        {
          message: error as string,
          type: 'custom',
          value: this.getValue(field),
        },
      ];
    } else {
      this.errors[field] = [
        ...(this.errors[field] ?? []),
        {
          message: error.message,
          type: error.type ?? 'custom',
          value: error.value ?? this.getValue(field),
        },
      ];
    }
  }

  @action
  clearError(field: ValueKey<Values>): void {
    if (this.errors[field]) {
      _unset(this.errors, field);
    }
  }

  @action
  clearErrors(): void {
    this.errors = new TrackedObject({});
  }

  @action
  unregister(
    field: ValueKey<Values>,
    { keepError, keepDirty, keepValue, keepDefaultValue }: UnregisterContext = {},
  ): void {
    const element = this.getDOMElement(field as string);

    assert('FORMIDABLE - No input element found to unregister', !!element);

    const { setAttribute } = inputUtils(element);

    setAttribute(UNREGISTERED_ATTRIBUTE, true);

    if (!keepError) {
      _unset(this.errors, field);
    }

    if (!keepDirty) {
      _unset(this.dirtyFields, field);
    }

    if (!keepValue) {
      _unset(this.values, field);
    }

    if (!keepDefaultValue) {
      _unset(this.rollbackValues, field);
    }
  }

  @action
  async setValue(
    field: ValueKey<Values>,
    value: any,
    { shouldValidate, shouldDirty }: SetContext = {},
  ): Promise<void> {
    this.values[field] = value as Values[ValueKey<Values>];

    if (shouldDirty) {
      this.dirtyField(field);
    }

    if (shouldValidate) {
      await this.validate(field);
    }
  }

  @action
  async setFocus(
    field: ValueKey<Values>,
    { shouldValidate, shouldDirty }: SetContext = {},
  ): Promise<void> {
    this.getDOMElement(field as string)?.focus();

    if (shouldDirty) {
      this.dirtyField(field);
    }

    if (shouldValidate) {
      await this.validate(field);
    }
  }

  // --- TASKS

  @action
  async validate(field?: ValueKey<Values>): Promise<void> {
    try {
      this.isValidating = true;

      if (!this.validator) {
        return;
      }

      const validation: FormidableErrors = await this.validator(this.parsedValues, {
        ...this.args.validatorOptions,
        shouldUseNativeValidation: this.args.shouldUseNativeValidation,
        nativeValidations: this.nativeValidations,
      } as ResolverOptions<ValidatorOptions>);

      if (field) {
        this.errors = _set(this.errors, field, get(validation, field));
      } else {
        this.errors = new TrackedObject(validation);
      }
    } finally {
      this.isValidating = false;
    }
  }

  @action
  async submit(event: SubmitEvent): Promise<void> {
    try {
      this.isSubmitting = true;
      this.isSubmitted = true;

      event.preventDefault();

      if (this.shouldValidateOrRevalidate('onSubmit')) {
        await this.validate();
      }

      this.isSubmitSuccessful = this.isValid;

      if (!this.isSubmitSuccessful) {
        return;
      }

      if (this.args.onSubmit) {
        return this.args.onSubmit(event, this.api);
      }

      if (this.handleOn.includes('onSubmit') && this.args.handler) {
        this.args.handler(this.parsedValues, this.api);
      }
    } finally {
      this.isSubmitting = false;
      this.submitCount += 1;
    }
  }

  register = modifier<RegisterModifier<Values>>(
    (
      input,
      [_name] = [undefined],
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
      } = {},
    ) => {
      const {
        setAttribute,
        isFormInput,
        isInput,
        isCheckbox,
        isRadio,
        isTextarea,
        isSelect,
        name: attrName,
      } = inputUtils(input);

      const name = _name ?? attrName;

      assert(
        `FORMIDABLE - Your element must have a name ; either specify it in the register parameters, or assign it directly to the element.
        Examples:
        <input name="foo" {{api.register}} />
        OR
        <input {{api.register "foo"}} />
      `,
        !!name,
      );

      // PARSERS
      this.parsers[name] = {
        valueAsNumber,
        valueAsDate,
        valueAsBoolean,
        valueFormat,
      };

      if (!isFormInput) {
        setAttribute(DATA_NAME, name as string);
        setAttribute(DATA_DISABLED, disabled);
        setAttribute(DATA_REQUIRED, required);

        return;
      }

      // ATTRIBUTES

      if (
        (isInput && (input as HTMLInputElement).type === 'number') ||
        (input as HTMLInputElement).type === 'time'
      ) {
        setAttribute('min', min);
        setAttribute('max', max);
      } else if (isInput || isTextarea) {
        setAttribute('minlength', minLength);
        setAttribute('maxlength', maxLength);

        if (isInput) {
          const strPattern = typeof pattern === 'string' ? pattern : pattern?.toString();

          setAttribute('pattern', strPattern);
        }
      }

      if (isFormInput) {
        setAttribute('disabled', disabled);
        setAttribute('required', required);
        setAttribute('name', name as string);

        const value = this.getValue(name);

        if (isRadio || isCheckbox) {
          const checked = Array.isArray(value)
            ? value.includes((input as HTMLInputElement).value)
            : (input as HTMLInputElement).value === value;

          (input as HTMLInputElement).checked = checked;
          setAttribute('aria-checked', checked);
        } else if (isInput || isTextarea) {
          (input as HTMLInputElement).value = (value as string) ?? '';
        }
      }

      // HANDLERS
      const handleChange = async (event: Event): Promise<void> => {
        await this.onChange(name, event, onChange);
      };

      const handleBlur = async (event: Event): Promise<void> => {
        await this.onBlur(name, event, onBlur);
      };

      const handleFocus = async (event: Event): Promise<void> => {
        await this.onFocus(name, event, onFocus);
      };

      const preventDefault = (e: Event): void => {
        if (!this.args.shouldUseNativeValidation) {
          e.preventDefault();
        }
      };

      this.nativeValidations[name] = {
        required,
        maxLength,
        minLength,
        max,
        min,
        pattern,
      };

      // EVENTS

      input.addEventListener(isInput || isSelect || isTextarea ? 'input' : 'change', handleChange);
      input.addEventListener('invalid', preventDefault);

      if (onBlur || this.shouldValidateOrRevalidate('onBlur') || this.handleOn.includes('onBlur')) {
        input.addEventListener('blur', handleBlur);
      }

      if (
        onFocus ||
        this.shouldValidateOrRevalidate('onFocus') ||
        this.handleOn.includes('onFocus')
      ) {
        input.addEventListener('focusin', handleFocus);
      }

      return (): void => {
        input.removeEventListener(
          isInput || isSelect || isTextarea ? 'input' : 'change',
          handleChange,
        );
        input.removeEventListener('invalid', preventDefault);

        if (
          onBlur ||
          this.shouldValidateOrRevalidate('onBlur') ||
          this.handleOn.includes('onBlur')
        ) {
          input.removeEventListener('blur', handleBlur);
        }

        if (
          onFocus ||
          this.shouldValidateOrRevalidate('onFocus') ||
          this.handleOn.includes('onFocus')
        ) {
          input.removeEventListener('focus', handleFocus);
        }
      };
    },
  );

  async onChange(
    field: ValueKey<Values>,
    event: Event,
    onChange?: (event: Event, api: FormidableApi<GenericObject>) => void,
  ): Promise<void> {
    assert('FORMIDABLE - No input element found when value got set.', !!event.target);

    await this.setValue(
      field,
      valueIfChecked(event, this.getValue(field), this.getDefaultValue(field)),
      {
        shouldValidate: this.shouldValidateOrRevalidate('onChange'),
        shouldDirty: true,
      },
    );

    if (onChange) {
      return onChange(event, this.api as FormidableApi<GenericObject>);
    }

    if (this.handleOn.includes('onChange') && this.args.handler) {
      this.args.handler(this.parsedValues, this.api);
    }
  }

  async onBlur(
    field: ValueKey<Values>,
    event: Event,
    onBlur?: (event: Event, api: FormidableApi<GenericObject>) => void,
  ): Promise<void> {
    assert('FORMIDABLE - No input element found when value got set.', !!event.target);

    await this.setValue(
      field,
      valueIfChecked(event, this.getValue(field), this.getDefaultValue(field)),
      {
        shouldValidate: this.shouldValidateOrRevalidate('onBlur'),
      },
    );

    if (onBlur) {
      return onBlur(event, this.api as FormidableApi<GenericObject>);
    }

    if (this.handleOn.includes('onBlur') && this.args.handler) {
      this.args.handler(this.parsedValues, this.api);
    }
  }

  async onFocus(
    field: ValueKey<Values>,
    event: Event,
    onFocus?: (event: Event, api: FormidableApi<GenericObject>) => void,
  ): Promise<void> {
    assert('FORMIDABLE - No input element found when value got set.', !!event.target);

    await this.setValue(
      field,
      valueIfChecked(event, this.getValue(field), this.getDefaultValue(field)),
      {
        shouldValidate: this.shouldValidateOrRevalidate('onFocus'),
      },
    );

    if (onFocus) {
      return onFocus(event, this.api as FormidableApi<GenericObject>);
    }

    if (this.handleOn.includes('onFocus') && this.args.handler) {
      this.args.handler(this.parsedValues, this.api);
    }
  }

  dirtyField(field: ValueKey<Values>): void {
    this.dirtyFields[field] = !_isEqual(
      get(this.rollbackValues, field),
      get(this.parsedValues, field),
    );
  }

  private shouldValidateOrRevalidate(eventType: HandlerEvent) {
    return this.submitCount > 0
      ? this.revalidateOn.includes(eventType)
      : this.validateOn.includes(eventType);
  }

  private getDOMElement(name: string): HTMLInputElement | null {
    return (
      (document.querySelector(`[name="${name as string}"]`) as HTMLInputElement | null) ??
      (document.querySelector(`[${DATA_NAME}="${name as string}"]`) as HTMLInputElement | null)
    );
  }

  <template>
    {{yield this.parsedValues this.api}}
  </template>
}
