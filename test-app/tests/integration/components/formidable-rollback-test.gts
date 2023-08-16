/* eslint-disable qunit/require-expect */
import { hbs } from 'ember-cli-htmlbars';
import { module, test } from 'qunit';
import { setupRenderingTest } from 'test-app/tests/helpers';
import { FormidableContext } from 'test-app/tests/types';

import { click, fillIn, render } from '@ember/test-helpers';

module('Integration | Component | formidable', function (hooks) {
  setupRenderingTest(hooks);

  test('Rollback -- text -- no options -- It should rollback the value', async function (this: FormidableContext, assert) {
    this.values = {
      foo: 'DEFAULT',
    };
    this.onUpdate = (_data, api: { rollback: () => void }) => {
      api.rollback();
    };
    await render(hbs`
      <Formidable @values={{this.values}} @onValuesChanged={{this.onUpdate}} as |values api|>
        <form {{on "submit" api.onSubmit}}>
          <input type="text" id="foo" {{api.register "foo"}} />
          {{#if api.isSubmitted}}
             <p id="is-submitted">SUBMITTED</p>
          {{/if}}
          <button id="submit"  type="submit">SUBMIT</button>
        </form>
      </Formidable>
    `);

    assert.dom('#foo').hasValue('DEFAULT');

    await fillIn('#foo', 'CHANGED');
    assert.dom('#foo').hasValue('CHANGED');
    await click('#submit');
    assert.dom('#foo').hasValue('DEFAULT');
    assert.dom('#is-submitted').doesNotExist();
  });

  test('Rollback -- defaultValue -- The default value should be reset', async function (this: FormidableContext, assert) {
    this.values = {
      foo: 'DEFAULT',
    };

    await render(hbs`
      <Formidable @values={{this.values}} as |values api|>
        <form {{on "submit" api.onSubmit}}>
          <input type="text" id="foo" {{api.register "foo"}} />
          <input type="text" id="bar" {{api.register "bar"}} />
          <button
            id="rollback"
            type="button"
            {{on "click" (fn api.rollback "foo" (hash defaultValue="Shiny and new!"))}}
          >
            ROLLBACK
          </button>
          <p id="df-foo">{{get api.defaultValues 'foo'}}</p>
        </form>
      </Formidable>
    `);

    assert.dom('#df-foo').hasText('DEFAULT');
    await fillIn('#foo', 'UPDATED');
    await click('#rollback');
    assert.dom('#df-foo').hasText('Shiny and new!');
    assert.dom('#foo').hasValue('Shiny and new!');
  });

  test('Rollback -- number -- no options -- It should rollback the value ', async function (this: FormidableContext, assert) {
    this.values = {
      foo: 404,
    };
    this.onUpdate = (_data, api: { rollback: () => void }) => {
      api.rollback();
    };
    await render(hbs`
      <Formidable @values={{this.values}} @onValuesChanged={{this.onUpdate}} as |values api|>
        <form {{on "submit" api.onSubmit}}>
          <input type="text" id="foo" {{api.register "foo" valueAsNumber=true}} />
          {{#if api.isSubmitted}}
             <p id="is-submitted">SUBMITTED</p>
          {{/if}}
          <button id="submit"  type="submit">SUBMIT</button>
        </form>
      </Formidable>
    `);
    assert.dom('#foo').hasValue('404');
    await fillIn('#foo', '5');
    assert.dom('#foo').hasValue('5');
    await click('#submit');
    assert.dom('#foo').hasValue('404');
    assert.dom('#is-submitted').doesNotExist();
  });

  test('Rollback -- date -- no options -- It should rollback the value ', async function (this: FormidableContext, assert) {
    this.values = {
      foo: new Date('2000-05-05'),
    };
    this.onUpdate = (_data, api: { rollback: () => void }) => {
      api.rollback();
    };
    await render(hbs`
      <Formidable @values={{this.values}} @onValuesChanged={{this.onUpdate}} as |values api|>
        <form {{on "submit" api.onSubmit}}>
          <input type="text" id="foo" {{api.register "foo" valueAsDate=true}} />
          {{#if api.isSubmitted}}
             <p id="is-submitted">SUBMITTED</p>
          {{/if}}
          <button id="submit"  type="submit">SUBMIT</button>
        </form>
      </Formidable>
    `);
    assert.dom('#foo').hasValue(new Date('2000-05-05').toString());
    await fillIn('#foo', '2001-05-05');
    assert.dom('#foo').hasValue(new Date('2001-05-05').toString());
    await click('#submit');
    assert.dom('#foo').hasValue(new Date('2000-05-05').toString());
    assert.dom('#is-submitted').doesNotExist();
  });

  test('Rollback -- object -- no options -- It should rollback the value ', async function (this: FormidableContext, assert) {
    this.values = {
      foo: { bar: 'DEFAULT' },
    };
    this.onUpdate = (_data, api: { rollback: () => void }) => {
      api.rollback();
    };

    await render(hbs`
      <Formidable @values={{this.values}} @onValuesChanged={{this.onUpdate}} as |values api|>
        <form {{on "submit" api.onSubmit}}>
          <input type="text" id="foo" {{api.register "foo.bar"}} />
          {{#if api.isSubmitted}}
             <p id="is-submitted">SUBMITTED</p>
          {{/if}}
          <button id="submit"  type="submit">SUBMIT</button>
        </form>
      </Formidable>
    `);

    assert.dom('#foo').hasValue('DEFAULT');
    await fillIn('#foo', 'CHANGED');
    assert.dom('#foo').hasValue('CHANGED');
    await click('#submit');
    assert.dom('#foo').hasValue('DEFAULT');
    assert.dom('#is-submitted').doesNotExist();
  });

  test('Rollback -- array -- no options -- It should rollback the value ', async function (this: FormidableContext, assert) {
    this.values = {
      foo: ['A', 'B'],
    };
    this.onUpdate = (_data, api: { rollback: () => void }) => {
      api.rollback();
    };
    await render(hbs`
      <Formidable @values={{this.values}} @onValuesChanged={{this.onUpdate}} as |values api|>
        <form {{on "submit" api.onSubmit}}>
          <input type="text" id="foo0" {{api.register "foo.0"}} />
          <input type="text" id="foo1" {{api.register "foo.1"}} />
          {{#if api.isSubmitted}}
             <p id="is-submitted">SUBMITTED</p>
          {{/if}}
          <button id="submit"  type="submit">SUBMIT</button>
        </form>
      </Formidable>
    `);
    assert.dom('#foo0').hasValue('A');
    assert.dom('#foo1').hasValue('B');

    await fillIn('#foo0', '*');
    await fillIn('#foo1', '**');
    assert.dom('#foo0').hasValue('*');
    assert.dom('#foo1').hasValue('**');
    await click('#submit');
    assert.dom('#foo0').hasValue('A');
    assert.dom('#foo1').hasValue('B');
    assert.dom('#is-submitted').doesNotExist();
  });

  test('Values -- It should rollback the value -- model', async function (this: FormidableContext, assert) {
    const store = this.owner.lookup('service:store');
    this.values = store.createRecord('child', {
      str: 'Child',
      bool: false,
      num: 2,
      date: new Date('2000-01-01'),
      obj: { foo: { bar: 'Biz' }, ember: 'Ness' },
    });

    this.onUpdate = (_data, api: { rollback: () => void }) => {
      api.rollback();
    };

    await render(hbs`
      <Formidable @values={{this.values}} @onValuesChanged={{this.onUpdate}} as |values api|>
        <form {{on "submit" api.onSubmit}}>
          <input type="text" id="child-str" {{api.register "str"}} />
          <input type="checkbox" id="child-bool" {{api.register "bool"}} />
          <input type="text" id="child-num" {{api.register "num" valueAsNumber=true}} />
          <input type="text" id="child-date" {{api.register "date" valueAsDate=true}} />
          <input type="text" id="child-obj-foo" {{api.register "obj.foo.bar"}} />
          <input type="text" id="child-obj-ember" {{api.register "obj.ember"}} />
          <button id="submit"  type="submit">SUBMIT</button>
        </form>
      </Formidable>
    `);

    assert.dom('#child-str').hasValue('Child');
    assert.dom('#child-bool').isNotChecked();
    assert.dom('#child-num').hasValue('2');
    assert.dom('#child-date').hasValue(new Date('2000-01-01').toString());
    assert.dom('#child-obj-foo').hasValue('Biz');
    assert.dom('#child-obj-ember').hasValue('Ness');

    await fillIn('#child-str', 'New Child');
    await click('#child-bool');
    await fillIn('#child-num', '202');
    await fillIn('#child-date', new Date('1990-01-01').toString());
    await fillIn('#child-obj-foo', 'Bonjour');
    await fillIn('#child-obj-ember', 'Paris');

    assert.dom('#child-str').hasValue('New Child');
    assert.dom('#child-bool').isChecked();
    assert.dom('#child-num').hasValue('202');
    assert.dom('#child-date').hasValue(new Date('1990-01-01').toString());
    assert.dom('#child-obj-foo').hasValue('Bonjour');
    assert.dom('#child-obj-ember').hasValue('Paris');

    await click('#submit');

    assert.dom('#child-str').hasValue('Child');
    assert.dom('#child-bool').isNotChecked();
    assert.dom('#child-num').hasValue('2');
    assert.dom('#child-date').hasValue(new Date('2000-01-01').toString());
    assert.dom('#child-obj-foo').hasValue('Biz');
    assert.dom('#child-obj-ember').hasValue('Ness');
  });
});
