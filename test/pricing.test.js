const test = require('node:test');
const assert = require('node:assert/strict');
const { priceOf, costOf } = require('../src/main/pricing');

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const M = 1_000_000;

test('a million of each kind costs the listed price', () => {
  near(costOf('claude-opus-5-5', { input: M }), 4);
  near(costOf('claude-opus-5-5', { output: M }), 20);
  near(costOf('claude-opus-5-5', { cacheWrite: M }), 5);
  near(costOf('claude-opus-5-5', { cacheRead: M }), 0.2);
  near(costOf('claude-sonnet-5-5', { cacheRead: M }), 0.1);
  near(costOf('claude-fable-5-1', { cacheRead: M }), 0.25);
  near(costOf('gpt-5.6-terra', { input: M, cacheRead: M, output: M }), 2 + 0.2 + 12);
});

test('narrower model ids win over wider ones', () => {
  assert.deepEqual(priceOf('claude-opus-5-5'), [4, 5, 0.2, 20]);
  assert.deepEqual(priceOf('claude-opus-5'), [5, 6.25, 0.5, 25]);
  assert.deepEqual(priceOf('claude-opus-4-5-20251101'), [5, 6.25, 0.5, 25]);
  assert.deepEqual(priceOf('claude-opus-4-1-20250805'), [15, 18.75, 1.5, 75]);
  assert.deepEqual(priceOf('claude-opus-4-20250514'), [15, 18.75, 1.5, 75]);
  assert.deepEqual(priceOf('claude-fable-5'), [10, 12.5, 1, 50]);
  assert.deepEqual(priceOf('claude-sonnet-4-6'), [3, 3.75, 0.3, 15]);
  assert.deepEqual(priceOf('gpt-5.6-luna'), [0.2, 0, 0.02, 1.2]);
});

test('short names, a context suffix and unknown models', () => {
  assert.deepEqual(priceOf('fable'), priceOf('claude-fable-5-1'));
  assert.deepEqual(priceOf('opus'), priceOf('claude-opus-5-5'));
  assert.deepEqual(priceOf('Sonnet'), priceOf('claude-sonnet-5-5'));
  assert.deepEqual(priceOf('claude-opus-5-5[1m]'), priceOf('claude-opus-5-5'));
  assert.equal(priceOf('<synthetic>'), null);
  assert.equal(priceOf(''), null);
  assert.equal(costOf('llama3', { input: M }), null);
});

test('one-hour cache writes cost twice the input price', () => {
  near(costOf('claude-opus-5-5', { cacheWrite: M, cacheWrite1h: M }), 8);
  near(costOf('claude-opus-5-5', { cacheWrite: 2 * M, cacheWrite1h: M }), 5 + 8);
});

test('Claude Haiku 5.5 is dearer for prompts over 100,000 tokens', () => {
  near(costOf('claude-haiku-5-5', { input: 100_000 }), 0.01);
  near(costOf('claude-haiku-5-5', { input: 50_000, cacheRead: 60_000, output: 1000 }), (50_000 * 0.5 + 60_000 * 0.05 + 1000 * 2.5) / M);
});

test('fast mode doubles the price', () => {
  near(costOf('claude-opus-5-5', { input: M, output: M }, { fast: true }), 48);
});
