import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { loadDestinationPack } from '../../apps/api/src/destination-pack';
import { buildApp } from '../../apps/api/src/app';
import type { Pool } from 'pg';

const approvedDigest = '78f5ba6c78041a2f7cff89ad032c5df7a5a03c9dddbe63150d7ca2d23be4bc93';

describe('A03 — The Mystery Destination Pack', () => {
  it('rejects an altered pack before parsing it (security regression)', async () => {
    const parseSpy = vi.spyOn(JSON, 'parse');
    await expect(
      loadDestinationPack(resolve('database/fixtures/destination-pack-altered.json'), approvedDigest)
    ).rejects.toThrow(/integrity check failed/);
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it('serves the approved pack through the catalogue endpoint without any flag', async () => {
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false, diagnosticsEnabled: false });
    const response = await app.inject({ method: 'GET', url: '/api/destination-pack' });
    expect(response.statusCode).toBe(200);
    expect(response.json().integrity.calculated).toBe(approvedDigest);
    expect(response.body).not.toMatch(/FLAG\{/);
    await app.close();
  });
  it('preserves the positive path for the approved pack', async () => {
    const loaded = await loadDestinationPack(resolve('database/fixtures/destination-pack-approved.json'), approvedDigest);
    expect(loaded.integrity.calculated).toBe(approvedDigest);
    expect(loaded.pack.supplier).toBe('HolbieTripsSync');
  });
});
