import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';
import { tokenDigest } from '../../apps/api/src/security';

const ALICE_BOOKING = '40000000-0000-4000-8000-000000000001';
const BRUNO_BOOKING = '40000000-0000-4000-8000-000000000002';

const alice = {
  id: '10000000-0000-4000-8000-000000000001',
  email: 'alice.martin@example.test',
  full_name: 'Alice Martin',
  role: 'customer'
};

const bruno = {
  id: '10000000-0000-4000-8000-000000000002',
  email: 'bruno.dupont@example.test',
  full_name: 'Bruno Dupont',
  role: 'customer'
};

const supportAgent = {
  id: '10000000-0000-4000-8000-000000000099',
  email: 'support@holbietrips.test',
  full_name: 'Support HolbieTrips',
  role: 'support'
};

// token -> account served by the `sessions` lookup, keyed by the same digest the
// real session guard computes from the bearer token.
const SESSIONS: Record<string, typeof alice> = {
  [tokenDigest('alice-session')]: alice,
  [tokenDigest('bruno-session')]: bruno,
  [tokenDigest('support-session')]: supportAgent
};

const bookings = new Map([
  [ALICE_BOOKING, { id: ALICE_BOOKING, user_id: alice.id, reference: 'HT-ALICE-001', itinerary_notes: 'Transfert vers l’hôtel inclus.' }],
  [BRUNO_BOOKING, { id: BRUNO_BOOKING, user_id: bruno.id, reference: 'HT-BRUNO-001', itinerary_notes: 'Cabine 12, pont Panorama.' }]
]);

function fakePool() {
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM sessions')) {
        const account = SESSIONS[String(params[0])];
        return { rowCount: account ? 1 : 0, rows: account ? [account] : [] };
      }
      if (sql.includes('FROM bookings b') && sql.includes('WHERE b.id=$1')) {
        const booking = bookings.get(String(params[0]));
        return { rowCount: booking ? 1 : 0, rows: booking ? [booking] : [] };
      }
      throw new Error(`Requête inattendue dans le double de test: ${sql}`);
    }),
    end: vi.fn(async () => undefined)
  };
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

describe('A01 — Boarding Pass Mix-Up', () => {
  it('régression sécurité : Alice ne peut plus lire la réservation de Bruno', async () => {
    const app = await buildApp(fakePool() as unknown as Pool, { serveFrontend: false });
    opened.push(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/bookings/${BRUNO_BOOKING}`,
      headers: { authorization: 'Bearer alice-session' }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).not.toHaveProperty('booking');
    expect(response.body).not.toMatch(/FLAG\{/);
  });

  it('préserve le parcours positif : Alice peut lire sa propre réservation', async () => {
    const app = await buildApp(fakePool() as unknown as Pool, { serveFrontend: false });
    opened.push(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/bookings/${ALICE_BOOKING}`,
      headers: { authorization: 'Bearer alice-session' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().booking.reference).toBe('HT-ALICE-001');
  });

  it('préserve l’accès support : le support peut lire une réservation via son identifiant', async () => {
    const app = await buildApp(fakePool() as unknown as Pool, { serveFrontend: false });
    opened.push(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/bookings/${BRUNO_BOOKING}`,
      headers: { authorization: 'Bearer support-session' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().booking.reference).toBe('HT-BRUNO-001');
  });
});