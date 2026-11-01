const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, extractEmailsFromHtml, toCsv } = require('../scripts/prospect');

test('founder lookup is opt-in and unsafe offset is rejected', () => {
  assert.equal(parseArgs([]).skipFounders, true);
  assert.equal(parseArgs(['--experimental-founders']).skipFounders, false);
  assert.throws(() => parseArgs(['--offset', '25']), /disabled/);
});

test('email extraction only accepts addresses at the company domain', () => {
  assert.deepEqual(extractEmailsFromHtml('info@example.org support@other.org', 'example.org'), ['info@example.org']);
});

test('CSV quotes values and escapes embedded quotes', () => {
  assert.equal(toCsv([{name: 'A, "B"'}]), '"name"\n"A, ""B"""\n');
});
