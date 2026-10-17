import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';

const alice = {
  id: '10000000-0000-4000-8000-000000000001',
  email: 'alice.martin@example.test',
  full_name: 'Alice Martin',
  role: 'customer'
};

const OWNED_BOOKING = '40000000-0000-4000-8000-000000000001';

type StackOptions = {
  cancellable?: boolean;      // l'UPDATE trouve-t-il une réservation annulable possédée ?
  auditShouldThrow?: boolean; // simule un échec d'écriture d'audit
};

/**
 * Double de pool + client transactionnel partageant un journal d'appels.
 * `clientCalls` enregistre chaque requête exécutée dans la transaction.
 */
function makeStack({ cancellable = true, auditShouldThrow = false }: StackOptions = {}) {
  const clientCalls: Array<{ sql: string; params: unknown[] }> = [];

  const clientQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
    clientCalls.push({ sql, params });
    if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql.trim())) return { rowCount: 0, rows: [] };
    if (sql.includes("UPDATE bookings SET status='cancelled'")) {
      return cancellable
        ? { rowCount: 1, rows: [{ id: OWNED_BOOKING, reference: 'HT-ALICE-001', status: 'cancelled' }] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes('INSERT INTO audit_events')) {
      if (auditShouldThrow) throw new Error('audit insert failed');
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  });

  const client = { query: clientQuery, release: vi.fn(() => undefined) };

  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [alice] };
      return { rowCount: 0, rows: [] };
    }),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined)
  };

  return { pool, clientCalls };
}

/** Extrait les actions d'audit écrites dans la transaction. */
function auditActions(clientCalls: Array<{ sql: string; params: unknown[] }>) {
  return clientCalls
    .filter(c => c.sql.includes('INSERT INTO audit_events'))
    .map(c => String(c.params[1])); // params: [user_id, action, entity_type, entity_id, metadata]
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

describe('A09 — The Silent Suitcase', () => {
  it('parcours positif : une réservation possédée est annulée, sans drapeau', async () => {
    const { pool, clientCalls } = makeStack();
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const res = await app.inject({
      method: 'POST',
      url: `/api/bookings/${OWNED_BOOKING}/cancel`,
      headers: { authorization: 'Bearer alice' }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().booking).toMatchObject({ reference: 'HT-ALICE-001', status: 'cancelled' });
    expect(res.body).not.toMatch(/FLAG\{/); // la réponse pédagogique a disparu
  });

  it('régression sécurité : une annulation réussie écrit un événement d’audit atomiquement', async () => {
    const { pool, clientCalls } = makeStack();
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const res = await app.inject({
      method: 'POST',
      url: `/api/bookings/${OWNED_BOOKING}/cancel`,
      headers: { authorization: 'Bearer alice' }
    });

    expect(res.statusCode).toBe(200);
    // Un événement booking.cancelled est bien inséré...
    expect(auditActions(clientCalls)).toContain('booking.cancelled');
    // ...dans la même transaction que l'UPDATE métier (BEGIN ... COMMIT).
    const sqls = clientCalls.map(c => c.sql.trim());
    expect(sqls.some(s => s.startsWith('BEGIN'))).toBe(true);
    expect(sqls.some(s => s.startsWith('COMMIT'))).toBe(true);
  });

  it('régression sécurité : une tentative sur une réservation non annulable est refusée sans mutation', async () => {
    const { pool, clientCalls } = makeStack({ cancellable: false });
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const res = await app.inject({
      method: 'POST',
      url: `/api/bookings/${OWNED_BOOKING}/cancel`,
      headers: { authorization: 'Bearer alice' }
    });

    expect(res.statusCode).toBe(404);
    // Aucune confirmation d'annulation...
    expect(auditActions(clientCalls)).not.toContain('booking.cancelled');
    // ...mais le refus suspect est tracé.
    expect(auditActions(clientCalls)).toContain('booking.cancel_denied');
  });

  it('atomicité : si l’écriture d’audit échoue, l’annulation est annulée (rollback)', async () => {
    const { pool, clientCalls } = makeStack({ cancellable: true, auditShouldThrow: true });
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const res = await app.inject({
      method: 'POST',
      url: `/api/bookings/${OWNED_BOOKING}/cancel`,
      headers: { authorization: 'Bearer alice' }
    });

    expect(res.statusCode).toBe(500);
    const sqls = clientCalls.map(c => c.sql.trim());
    expect(sqls.some(s => s.startsWith('ROLLBACK'))).toBe(true);
    expect(sqls.some(s => s.startsWith('COMMIT'))).toBe(false);
  });
});