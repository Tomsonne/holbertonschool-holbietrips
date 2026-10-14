import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';

function fakePool() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM trips')) {
        // Le mock ne révèle le trip caché que si le prédicat SQL a été altéré
        // par concaténation. Avec le binding, la charge part en paramètre et
        // le SQL ne contient plus 'OR 1=1'.
        const injected = sql.includes('OR 1=1');
        return { rowCount: 1, rows: [{
          id: injected ? 'hidden' : 'kyoto', slug: injected ? 'archive-search-party' : 'kyoto-saisons',
          title: injected ? 'Dossier interne' : 'Kyoto au rythme des saisons', destination: injected ? 'Archive' : 'Kyoto, Japon',
          description: injected ? 'Voyage interne réservé aux essais' : 'Temples et jardins', departure_date: '2027-10-03',
          return_date: '2027-10-12', price_cents: 219900, seats_available: 9, image_key: 'kyoto'
        }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
    end: vi.fn(async () => undefined)
  };
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

describe('A05 — Search Party Crasher', () => {
  it('security regression: search input is bound as a parameter, not concatenated', async () => {
    const pool = fakePool();
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false, diagnosticsEnabled: false });
    opened.push(app);

    const response = await app.inject({ method: 'GET', url: `/api/trips?q=${encodeURIComponent("%' OR 1=1) -- ")}` });
    expect(response.statusCode).toBe(200);

    const [sql, params] = pool.query.mock.calls[0];
    // La charge d'injection n'apparaît pas dans le texte SQL
    expect(sql).not.toContain('OR 1=1');
    // Elle est passée comme valeur liée ($1)
    expect(sql).toContain('$1');
    expect(params).toEqual([expect.stringContaining("OR 1=1")]); 
 });

  it('security regression: the injection no longer leaks the unpublished trip or its flag', async () => {
    const app = await buildApp(fakePool() as unknown as Pool, { serveFrontend: false, diagnosticsEnabled: false });
    opened.push(app);

    const response = await app.inject({ method: 'GET', url: `/api/trips?q=${encodeURIComponent("%' OR 1=1) -- ")}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(/FLAG\{a05_/);
    expect(response.body).not.toContain('archive-search-party');
  });

  it('business: an ordinary destination search still works', async () => {
    const app = await buildApp(fakePool() as unknown as Pool, { serveFrontend: false, diagnosticsEnabled: false });
    opened.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/trips?q=Kyoto' });
    expect(response.statusCode).toBe(200);
    expect(response.json().trips[0].title).toContain('Kyoto');
  });
});