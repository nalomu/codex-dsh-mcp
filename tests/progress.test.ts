import test from 'node:test';
import assert from 'node:assert/strict';
import { executionDetails } from '../src/progress.js';
import { redactor } from '../src/security.js';
test('execution details redact structured credentials before bounding output and omit binary payloads', () => {
  const result = executionDetails(
    {
      command: 'node --test',
      output: 'fixture-private-value',
      apiKey: 'hidden',
      content: { type: 'image', data: 'binary-data' },
    },
    redactor(['fixture-private-value']),
  );
  const text = JSON.stringify(result);
  assert.ok(text.includes('node --test'));
  assert.ok(!text.includes('fixture-private-value'));
  assert.ok(!text.includes('hidden'));
  assert.ok(!text.includes('binary-data'));
  const bounded = executionDetails(
    { output: 'abc fixture-private-value trailing'.repeat(10) },
    redactor(['fixture-private-value']),
    30,
  );
  assert.equal(bounded.truncated, true);
  assert.equal((bounded.details as string).length, 30);
  assert.ok(!(bounded.details as string).includes('fixture-private'));
});
