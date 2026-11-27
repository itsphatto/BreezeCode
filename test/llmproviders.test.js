const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/main/llmproviders');

test('filterModels gemini keeps chat models and strips models/', () => {
  const json = { data: [
    { id: 'models/gemini-2.5-flash' }, { id: 'models/gemini-2.5-pro' }, { id: 'models/text-embedding-004' },
    { id: 'models/gemini-2.5-flash-preview-tts' }, { id: 'models/gemini-2.5-flash-image' }, { id: 'models/gemini-live-2.5-flash' },
  ] };
  assert.deepEqual(llm.filterModels('gemini', json).models, ['gemini-2.5-flash', 'gemini-2.5-pro']);
});

test('filterModels openrouter keeps tool models with their context', () => {
  const json = { data: [
    { id: 'google/gemini-2.5-flash', context_length: 1048576, supported_parameters: ['tools', 'temperature'] },
    { id: 'x/no-tools', context_length: 8000, supported_parameters: ['temperature'] },
  ] };
  const r = llm.filterModels('openrouter', json);
  assert.deepEqual(r.models, ['google/gemini-2.5-flash']);
  assert.deepEqual(r.contexts, { 'google/gemini-2.5-flash': 1048576 });
});

test('filterModels local reads data or models', () => {
  assert.deepEqual(llm.filterModels('local', { models: [{ name: 'llama3.1' }] }).models, ['llama3.1']);
  assert.deepEqual(llm.filterModels('local', { data: [{ id: 'qwen2.5-coder' }] }).models, ['qwen2.5-coder']);
});

test('filterModels throws on an empty list', () => {
  assert.throws(() => llm.filterModels('gemini', { data: [] }));
  assert.throws(() => llm.filterModels('local', {}), /ollama pull llama3\.1/);
});

test('defaultModel gemini picks the newest flash', () => {
  assert.equal(llm.defaultModel('gemini', ['gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']), 'gemini-2.5-flash');
  assert.equal(llm.defaultModel('gemini', ['gemini-2.5-pro']), 'gemini-2.5-pro');
});

test('defaultModel openrouter takes the first', () => {
  assert.equal(llm.defaultModel('openrouter', ['a/b', 'c/d']), 'a/b');
});

test('defaultModel openrouter prefers the newest Gemini Flash over a newer premium model', () => {
  assert.equal(llm.defaultModel('openrouter', ['x/brand-new-premium', 'google/gemini-2.0-flash', 'google/gemini-2.5-flash', 'google/gemini-2.5-pro']), 'google/gemini-2.5-flash');
});

test('keyCheckPath: only OpenRouter needs a separate key check', () => {
  assert.equal(llm.keyCheckPath('openrouter'), '/key');
  assert.equal(llm.keyCheckPath('gemini'), null);
  assert.equal(llm.keyCheckPath('local'), null);
});

test('refreshedEntry saves a changed model list and keeps the chosen model', () => {
  const saved = { model: 'a/b', models: ['a/b', 'c/d'], contexts: { 'a/b': 1000 } };
  const fresh = { models: ['a/b', 'e/f'], contexts: { 'a/b': 1000, 'e/f': 2000 } };
  assert.deepEqual(llm.refreshedEntry(saved, fresh), { model: 'a/b', models: ['a/b', 'e/f'], contexts: { 'a/b': 1000, 'e/f': 2000 } });
  assert.equal(llm.refreshedEntry(saved, { models: ['a/b', 'c/d'], contexts: { 'a/b': 1000 } }), null);
});

test('contextWindow follows each provider', () => {
  assert.equal(llm.contextWindow('local', { url: 'http://127.0.0.1:11434/v1' }), 4096);
  assert.equal(llm.contextWindow('local', { url: 'http://127.0.0.1:1234/v1' }), 8192);
  assert.equal(llm.contextWindow('local', { url: 'http://127.0.0.1:11434/v1', override: 32000 }), 32000);
  assert.equal(llm.contextWindow('gemini', { url: 'x' }), 128000);
  assert.equal(llm.contextWindow('gemini', { url: 'x', override: 32000 }), 128000);
  assert.equal(llm.contextWindow('openrouter', { url: 'x', model: 'm', contexts: { m: 1048576 } }), 128000);
  assert.equal(llm.contextWindow('openrouter', { url: 'x', model: 'm', contexts: { m: 32768 } }), 32768);
  assert.equal(llm.contextWindow('openrouter', { url: 'x', model: 'gone', contexts: { m: 32768 } }), 128000);
});

test('friendlyError explains key, quota and credit problems', () => {
  assert.match(llm.friendlyError('gemini', 429, {}).message, /free limit/i);
  for (const status of [401, 403]) {
    const m = llm.friendlyError('gemini', status, {}).message;
    assert.match(m, /rejected the key/i);
    assert.match(m, /aistudio\.google\.com\/apikey/);
  }
  const credits = llm.friendlyError('openrouter', 402, {}).message;
  assert.match(credits, /credits/i);
  assert.match(credits, /openrouter\.ai\/credits/);
  assert.match(llm.friendlyError('openrouter', 401, {}).message, /rejected the key/i);
  assert.equal(llm.friendlyError('gemini', 500, { error: { message: 'boom' } }).message, 'boom');
  assert.equal(llm.friendlyError('gemini', 500, [{ error: { message: 'wrapped' } }]).message, 'wrapped');
  assert.equal(llm.friendlyError('local', 500, {}).message, 'The server answered with status 500');
  assert.equal(llm.friendlyError('gemini', 429, {}).status, 429);
});

test('extraHeaders only for openrouter', () => {
  assert.deepEqual(llm.extraHeaders('openrouter'), { 'HTTP-Referer': 'https://breezecode.site/', 'X-Title': 'Breeze Code' });
  assert.deepEqual(llm.extraHeaders('gemini'), {});
});

test('isLlmAgent knows only the API providers', () => {
  assert.equal(llm.isLlmAgent('gemini'), true);
  assert.equal(llm.isLlmAgent('local'), true);
  assert.equal(llm.isLlmAgent('claude'), false);
  assert.equal(llm.isLlmAgent(undefined), false);
  assert.equal(llm.isLlmAgent('__proto__'), false);
});

test('deepseek: lists its models, starts on flash, caps the context', () => {
  const r = llm.filterModels('deepseek', { data: [{ id: 'deepseek-v4-pro', context_window: 1048576 }, { id: 'deepseek-flash', context_window: 65536 }] });
  assert.deepEqual(r.models, ['deepseek-v4-pro', 'deepseek-flash']);
  assert.equal(llm.defaultModel('deepseek', r.models), 'deepseek-flash');
  assert.equal(llm.defaultModel('deepseek', ['deepseek-v4-pro']), 'deepseek-v4-pro');
  assert.equal(llm.contextWindow('deepseek', { url: 'x', model: 'deepseek-v4-pro', contexts: r.contexts }), 128000);
  assert.equal(llm.contextWindow('deepseek', { url: 'x', model: 'deepseek-flash', contexts: r.contexts }), 65536);
  assert.equal(llm.contextWindow('deepseek', { url: 'x', override: 4096 }), 128000);
  assert.equal(llm.isLlmAgent('deepseek'), true);
  assert.equal(llm.keyCheckPath('deepseek'), null);
  assert.deepEqual(llm.extraHeaders('deepseek'), {});
  assert.equal(llm.LLM_PROVIDER_IDS.at(-1), 'deepseek');
});

test('deepseek: key, balance and rate errors say what to do', () => {
  assert.match(llm.friendlyError('deepseek', 401, {}).message, /DeepSeek API rejected the key.*platform[.]deepseek[.]com[/]api_keys/);
  assert.match(llm.friendlyError('deepseek', 402, {}).message, /platform[.]deepseek[.]com[/]top_up/);
  assert.match(llm.friendlyError('deepseek', 429, {}).message, /wait/i);
});

test('only deepseek keeps its thinking; deepseek and gemini can turn it down', () => {
  assert.deepEqual(llm.LLM_PROVIDER_IDS.filter(llm.keepsReasoning), ['deepseek']);
  assert.deepEqual(llm.withoutThinkingBody('deepseek'), { thinking: { type: 'disabled' } });
  assert.deepEqual(llm.withoutThinkingBody('gemini'), { reasoning_effort: 'low' });
  for (const id of ['local', 'openrouter']) assert.deepEqual(llm.withoutThinkingBody(id), {});
});

test('agent steps: gemini thinks low at its own temperature, the others run cool', () => {
  assert.deepEqual(llm.agentBody('gemini'), { reasoning_effort: 'low' });
  for (const id of ['local', 'openrouter', 'deepseek']) assert.deepEqual(llm.agentBody(id), { temperature: 0.2 });
});

// setup.ts is a page script, so the function is lifted out of it.
test('keyProvider tells a pasted key by its shape', () => {
  const { stripTypeScriptTypes } = require('node:module');
  const src = require('node:fs').readFileSync(require.resolve('../src/renderer/breeze/setup.ts'), 'utf8').replaceAll('\r', '');
  const keyProvider = require('node:vm').runInNewContext('(' + stripTypeScriptTypes(/function keyProvider[^]*?\n}/.exec(src)[0]) + ')');
  assert.equal(keyProvider('sk-' + '0123456789abcdef'.repeat(2)), 'deepseek');
  assert.equal(keyProvider('sk-or-v1-' + 'a'.repeat(64)), 'openrouter');
  assert.equal(keyProvider('AIzaSyX'), 'gemini');
  assert.equal(keyProvider('AQ.Ab8RN6' + 'x_y-Z'.repeat(9)), 'gemini'); // Google's newer key format
  assert.equal(keyProvider('AQ.short'), 'local');
  for (const k of ['', 'sk-1234', 'sk-lm-abc', 'sk-' + 'a'.repeat(33), 'sk-proj-' + 'a'.repeat(32)]) assert.equal(keyProvider(k), 'local', k);
});
