const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanTranscript } = require('../src/main/dictate');

test('cleanTranscript joins whisper segments into one line', () => {
  assert.equal(cleanTranscript(' Refactor the login function\r\n and add a test.\n'), 'Refactor the login function and add a test.');
});

test('cleanTranscript drops [BLANK_AUDIO] and (noise) marks', () => {
  assert.equal(cleanTranscript('[BLANK_AUDIO]\n'), '');
  assert.equal(cleanTranscript('(keyboard clicking) Hello [MUSIC] there'), 'Hello there');
});
