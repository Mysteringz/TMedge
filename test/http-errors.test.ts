import assert from 'node:assert/strict';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { asyncHandler, applicationErrorHandler } from '../src/infrastructure/http/errors.js';
import { ApplicationError } from '../src/modules/shared/application/contracts.js';
import { objectBody, validateBody } from '../src/infrastructure/http/validation.js';

async function withServer(work: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.post('/validated', validateBody(objectBody), asyncHandler(async (_req, res) => {
    res.json({ ok: true });
  }));
  app.get('/async-error', asyncHandler(async () => {
    throw new ApplicationError('unavailable', 'storage unavailable');
  }));
  app.get('/internal-error', asyncHandler(async () => {
    throw new Error('secret path');
  }));
  app.use(applicationErrorHandler);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await work(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('request body validation rejects non-object payloads before handler execution', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/validated`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'request body must be an object' });
  });
});

test('async route errors map typed unavailable failures centrally', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/async-error`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'storage unavailable' });
  });
});

test('unexpected async failures hide internal details', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/internal-error`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'internal server error' });
  });
});
