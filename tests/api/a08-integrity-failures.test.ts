import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';
import { config } from '../../apps/api/src/config';
import { paymentSignature } from '../../apps/api/src/security';

const BRUNO_BOOKING = '40000000-0000-4000-8000-000000000002';
const AMOUNT = 129900;

type SignedFields = {
  bookingId: string;
  amountCents: number;
  status: string;
  providerReference: string;
  cardLast4: string;
};

/** Reproduit l'ordre canonique signé par le simulateur et revérifié par l'API. */
function sign(fields: SignedFields) {
  return paymentSignature(fields, config.paymentKey);
}

/** Double de pool avec un état de réservation en mémoire (pending -> confirmed). */
function makeStack(total = AMOUNT) {
  const booking = { id: BRUNO_BOOKING, total_cents: total, status: 'pending' as 'pending' | 'confirmed' };

  const run = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT id,total_cents FROM bookings')) {
      const match = params[0] === booking.id && params[1] === booking.total_cents && booking.status === 'pending';
      return match
        ? { rowCount: 1, rows: [{ id: booking.id, total_cents: booking.total_cents }] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes('UPDATE bookings SET status=') && sql.includes("status='pending'")) {
      if (booking.status === 'pending') {
        booking.status = 'confirmed';
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }
    // INSERT payments, BEGIN/COMMIT/ROLLBACK, audit… : toléré
    return { rowCount: 0, rows: [] };
  };

  const client = { query: vi.fn(run), release: vi.fn(() => undefined) };
  const pool = {
    query: vi.fn(run),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined)
  };
  return { pool, booking };
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

function validFields(overrides: Partial<SignedFields> = {}): SignedFields {
  return {
    bookingId: BRUNO_BOOKING,
    amountCents: AMOUNT,
    status: 'approved',
    providerReference: 'FAKE-PROVIDER-REF',
    cardLast4: '4242',
    ...overrides
  };
}

describe('A08 — Payment Postcard Pretender', () => {
  it('parcours positif : un callback correctement signé confirme la réservation', async () => {
    const { pool, booking } = makeStack();
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const fields = validFields();
    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/callback',
      payload: { ...fields, signature: sign(fields) }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'confirmed' });
    expect(res.body).not.toMatch(/FLAG\{/);
    expect(booking.status).toBe('confirmed');
  });

  it('régression sécurité : un callback NON signé est rejeté (401) et préserve l’état', async () => {
    const { pool, booking } = makeStack();
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/callback',
      payload: validFields() // aucune signature
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).not.toMatch(/FLAG\{/);
    expect(booking.status).toBe('pending');
  });

  it('régression sécurité : un callback ALTÉRÉ après signature est rejeté (401)', async () => {
    const { pool, booking } = makeStack();
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const signed = validFields();
    const signature = sign(signed);
    // On signe un montant, on en envoie un autre : la signature ne couvre plus le message.
    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/callback',
      payload: { ...signed, amountCents: AMOUNT + 5000, signature }
    });

    expect(res.statusCode).toBe(401);
    expect(booking.status).toBe('pending');
  });

  it('régression sécurité : un montant NON concordant (mais bien signé) est rejeté (404)', async () => {
    const { pool, booking } = makeStack(); // réservation réelle à 129900
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    // Signature valide sur un faux montant : passe la vérif HMAC, mais ne correspond
    // à aucune réservation payable -> 404, l'état est préservé.
    const fields = validFields({ amountCents: 1 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/callback',
      payload: { ...fields, signature: sign(fields) }
    });

    expect(res.statusCode).toBe(404);
    expect(booking.status).toBe('pending');
  });

  it('régression sécurité : un REJEU sur une réservation déjà confirmée est rejeté (404)', async () => {
    const { pool, booking } = makeStack();
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const fields = validFields();
    const payload = { ...fields, signature: sign(fields) };

    const first = await app.inject({ method: 'POST', url: '/api/payments/callback', payload });
    expect(first.statusCode).toBe(200);
    expect(booking.status).toBe('confirmed');

    // Rejeu du même message signé : la réservation n'est plus 'pending'.
    const replay = await app.inject({ method: 'POST', url: '/api/payments/callback', payload });
    expect(replay.statusCode).toBe(404);
    expect(booking.status).toBe('confirmed'); // état préservé
  });
});