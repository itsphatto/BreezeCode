const test = require('node:test');
const assert = require('node:assert/strict');
const { PREVIEW_INSPECTOR } = require('../src/main/previewInspector');

test('the inspector injects as one inline script that parses', () => {
  const m = /^<script data-breeze-inspector>([\s\S]*)<\/script>$/.exec(PREVIEW_INSPECTOR);
  assert.ok(m, 'wrapped in a single <script> tag');
  // A "</script" inside the body would end the tag early and spill the rest into the page as text.
  assert.ok(!/<\/script/i.test(m[1]));
  assert.doesNotThrow(() => new Function(m[1]));
});

const { withPreviewExtras } = require('../src/main/previewServer');

test('preview extras go inside <head>, after the doctype', () => {
  const html = withPreviewExtras('<!doctype html><html><head><title>x</title></head><body></body></html>');
  assert.ok(html.startsWith('<!doctype html><html><head><style data-breeze-preview>'));
  assert.ok(html.includes(PREVIEW_INSPECTOR));
  assert.ok(withPreviewExtras('<p>bare</p>').endsWith(PREVIEW_INSPECTOR));
});
