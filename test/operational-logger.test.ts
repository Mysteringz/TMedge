import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operationalLog } from '../src/shared/logging/operational-logger.js';

test('operational logs keep correlation fields and omit credentials and raw payload fields', () => {
  const original = console.log;
  let line = '';
  console.log = (value?: unknown) => { line = String(value); };
  try {
    operationalLog('operation.failed', {
      operationId: 'op-1', component: 'test', outcome: 'failed', token: 'secret-value',
      password: 'private-password', rawFrame: [1, 2, 3], payload: 'sensitive', error: 'dsn=postgres://private',
    });
  } finally {
    console.log = original;
  }
  assert.match(line, /"operationId":"op-1"/);
  assert.doesNotMatch(line, /secret-value|private-password|postgres:|sensitive|\[1,2,3\]/);
});
