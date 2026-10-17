import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';

const alice = {
  id: '10000000-0000-4000-8000-000000000001',
  email: 'alice.martin@example.test',
  full_name: 'Alice Martin',
  role: 'customer'
};
const bookingId = '40000000-0000-4000-8000-000000000001';

type BookingState = { status: string; payment_status: string | null };

/**
 * Double de pool centré sur la route /confirm. L'état de la réservation
 * (statut métier + statut de paiement) est configurable, et toute confirmation
 * effective est enregistrée pour pouvoir vérifier qu'un refus ne mute rien.
 */
function makePool(initial: BookingState) {
  const state = { ...initial };
  const confirmations: string[] = [];

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM sessions')) {
      return { rowCount: 1, rows: [alice] };
    }
    if (sql.includes('SELECT b.id,b.status')) {
      return { rowCount: 1, rows: [{ id: bookingId, status: state.status, payment_status: state.payment_status }] };
    }
    if (sql.includes("UPDATE bookings SET status='confirmed'")) {
      confirmations.push(String(params[0]));
      state.status = 'confirmed';
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const pool = { query, end: vi.fn(async () => undefined) };
  return { pool, confirmations, state };
}

const JSON_HEADERS = { 'content-type': 'application/json', authorization: 'Bearer alice' };
const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

describe('A10 — The Emergency Exit Is Open', () => {
  it('régression sécurité : un contrôle obligatoire indisponible échoue fermé (pas de confirmation, pas de drapeau)', async () => {
    // Réservation réellement impayée : seule une faille « fail-open » pourrait la confirmer.
    const { pool, confirmations } = makePool({ status: 'pending', payment_status: null });
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/bookings/${bookingId}/confirm`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ simulateCheckFailure: true })
    });

    // Incertitude = refus retryable, jamais une approbation.
    expect(response.statusCode).toBe(503);
    // Aucune fuite d'interne ni de drapeau pédagogique.
    expect(response.body).not.toMatch(/FLAG\{/);
    expect(response.body).not.toMatch(/readiness|checker|unavailable|Error|stack/i);
    // L'état métier n'a pas changé : aucune confirmation n'a été écrite.
    expect(confirmations).toHaveLength(0);
  });

  it('parcours positif : une réservation en attente avec paiement approuvé est confirmée', async () => {
    const { pool, confirmations } = makePool({ status: 'pending', payment_status: 'approved' });
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/bookings/${bookingId}/confirm`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({})
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'confirmed' });
    expect(response.body).not.toMatch(/FLAG\{/);
    expect(confirmations).toEqual([bookingId]);
  });

  it('parcours métier : une réservation en attente sans paiement est refusée (état préservé)', async () => {
    const { pool, confirmations } = makePool({ status: 'pending', payment_status: null });
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/bookings/${bookingId}/confirm`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({})
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('FLAG{');
    expect(confirmations).toHaveLength(0);
  });
});
