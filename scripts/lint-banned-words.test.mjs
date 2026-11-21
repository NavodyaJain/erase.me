// banned-words:ignore-file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findViolations } from './lint-banned-words.mjs';

const rules = (s) => findViolations(s).map((v) => v.rule);

test('flags unhedged banned phrases', () => {
  assert.deepEqual(rules('We will delete your data.'), ['will-delete']);
  assert.deepEqual(rules('Your data will be deleted.'), ['will-delete']);
  assert.deepEqual(rules('Deletion is guaranteed.'), ['guaranteed']);
  assert.deepEqual(rules('This company is compliant.'), ['compliant']);
  assert.deepEqual(rules('A non-compliant company'), ['compliant']);
  assert.deepEqual(rules('Violating the Act is illegal'), ['legal-accusation', 'legal-accusation']);
  assert.deepEqual(rules('Your data is safe with us'), ['data-safe']);
  assert.deepEqual(rules('TicketLy leaked you'), ['leaked']);
  assert.deepEqual(rules('Your address was leaked'), ['leaked']);
});

test('allows hedged and negated wording', () => {
  assert.deepEqual(findViolations('TicketLy may have leaked you'), []);
  assert.deepEqual(findViolations('It might have leaked your address'), []);
  assert.deepEqual(findViolations('A company could also have leaked it'), []);
  assert.deepEqual(findViolations('Deletion is not guaranteed.'), []);
  assert.deepEqual(findViolations('We cannot say deletion is guaranteed'), []);
});

test('a hedge in an earlier sentence does not excuse a later claim', () => {
  assert.deepEqual(rules('It may be fine. TicketLy leaked you.'), ['leaked']);
});

test('catches phrases wrapped across lines and reports the right line', () => {
  const v = findViolations('line one\nWe will\n  delete it');
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 2);
});

test('ignore markers', () => {
  assert.deepEqual(findViolations('guaranteed // banned-words:ignore'), []);
  assert.deepEqual(findViolations('// banned-words:ignore-file\nwill delete'), []);
  assert.equal(findViolations('ok\nwill delete // banned-words:ignore\nguaranteed').length, 1);
});
