import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldOwnsKey } from './focus.ts';

/** Enough of an Element for the focus rules: they read the tag, the input type, and ancestors. */
const el = (tagName: string, type = '', ancestor = '') => ({ tagName, type, closest: (s: string) => (ancestor && s.includes(ancestor) ? {} : null) }) as unknown as Element;

test('a field you type in keeps every key', () => {
  for (const target of [el('INPUT', 'text'), el('INPUT', 'number'), el('TEXTAREA')])
    for (const key of [' ', 'ArrowLeft', 'Delete', 'v']) assert.equal(fieldOwnsKey(target, key), true);
});

test('a clicked button, checkbox or toggle keeps nothing — Space still plays', () => {
  for (const target of [el('BUTTON'), el('INPUT', 'checkbox'), el('INPUT', 'radio'), el('DIV')])
    for (const key of [' ', 'Enter', 'Delete', 'ArrowLeft']) assert.equal(fieldOwnsKey(target, key), false);
});

test('sliders and dropdowns keep their arrows and nothing else', () => {
  for (const target of [el('INPUT', 'range'), el('SELECT'), el('DIV', '', '[role="slider"]')]) {
    assert.equal(fieldOwnsKey(target, 'ArrowLeft'), true);
    assert.equal(fieldOwnsKey(target, ' '), false);
  }
});

test('an open modal owns the keyboard', () => {
  assert.equal(fieldOwnsKey(el('BUTTON', '', 'dialog[open]'), ' '), true);
});
