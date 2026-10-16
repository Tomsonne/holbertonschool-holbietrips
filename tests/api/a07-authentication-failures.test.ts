import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';
import { newToken, tokenDigest } from '../../apps/api/src/security';

const alice = { id: '10000000-0000-4000-8000-000000000001', email: 'alice.martin@example.test' };
const bruno = { id: '10000000-0000-4000-8000-000000000002', email: 'bruno.dupont@example.test' };

/** L'ancien jeton prévisible : simple encodage base64url de l'e-mail. */
const predictedToken = (email: string) => Buffer.from(email.toLowerCase(), 'utf8').toString('base64url');

type ResetRow = { user_id: string; expires_at: number; used_at: number | null };

/**
 * Double de pool + boîte de faux-mail partageant un même état en mémoire.
 * Modélise uniquement les requêtes du flux de reset ; le reste (audit, etc.)
 * est toléré en no-op.
 */
function makeStack() {
  const users = new Map<string, { id: string; email: string }>([
    [alice.email, { id: alice.id, email: alice.email }],
    [bruno.email, { id: bruno.id, email: bruno.email }]
  ]);
  const resetTokens = new Map<string, ResetRow>();
  const mailbox: Array<{ to: string; template: string; resetToken: string }> = [];

  const run = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM users') && sql.includes('WHERE email')) {
      const u = users.get(String(params[0]));
      return { rowCount: u ? 1 : 0, rows: u ? [u] : [] };
    }
    if (sql.includes('INSERT INTO password_reset_tokens')) {
      resetTokens.set(String(params[0]), {
        user_id: String(params[1]),
        expires_at: Date.now() + 15 * 60_000,
        used_at: null
      });
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('FROM password_reset_tokens') && sql.includes('FOR UPDATE')) {
      const row = resetTokens.get(String(params[0]));
      const valid = row && row.expires_at > Date.now() && row.used_at === null;
      return valid ? { rowCount: 1, rows: [{ user_id: row!.user_id }] } : { rowCount: 0, rows: [] };
    }
    if (sql.includes('UPDATE password_reset_tokens') && sql.includes('used_at')) {
      const row = resetTokens.get(String(params[0]));
      if (row) row.used_at = Date.now();
      return { rowCount: row ? 1 : 0, rows: [] };
    }
    // UPDATE users, DELETE sessions, BEGIN/COMMIT/ROLLBACK, audit… : toléré
    return { rowCount: 0, rows: [] };
  };

  const client = { query: vi.fn(run), release: vi.fn(() => undefined) };
  const pool = {
    query: vi.fn(run),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined)
  };

  // Intercepte l'appel sortant vers le faux-mail et capture le jeton livré,
  // comme si on lisait la boîte de réception interne.
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
    try {
      const body = JSON.parse(init.body ?? '{}');
      if (body && typeof body.resetToken === 'string') mailbox.push(body);
    } catch { /* ignore */ }
    return { ok: true, status: 201, json: async () => ({}) } as unknown as Response;
  }));

  return { pool, resetTokens, mailbox };
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map(app => app.close()));
  vi.unstubAllGlobals();
});

describe('A07 — Reset Route Roulette', () => {
  it('helper : newToken() est imprévisible et de forte entropie', () => {
    const a = newToken();
    const b = newToken();
    expect(a).not.toBe(b);
    // 32 octets encodés en base64url → 43 caractères de l'alphabet url-safe
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('parcours positif : un reset HTTP complet aboutit avec le jeton livré par mail', async () => {
    const stack = makeStack();
    const app = await buildApp(stack.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const requested = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/request',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ email: bruno.email })
    });
    expect(requested.statusCode).toBe(200);
    // L'API de demande ne révèle JAMAIS le jeton.
    expect(requested.body).not.toMatch(/resetToken|token/i);

    // On récupère le vrai jeton aléatoire depuis le service de faux-mail.
    const mail = stack.mailbox.at(-1);
    expect(mail?.to).toBe(bruno.email);
    expect(mail?.resetToken).toBeTruthy();
    // C'est bien de l'aléa, pas l'e-mail encodé.
    expect(mail?.resetToken).not.toBe(predictedToken(bruno.email));

    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ token: mail!.resetToken, password: 'LegitPassw0rd!' })
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toEqual({ ok: true });
    // Plus aucune fuite de flag pédagogique.
    expect(confirmed.body).not.toMatch(/FLAG\{/);
  });

  it('régression sécurité : un jeton prédit depuis l’e-mail est rejeté', async () => {
    const stack = makeStack();
    const app = await buildApp(stack.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    // L'attaquant déclenche la demande en ne connaissant que l'adresse…
    await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/request',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ email: bruno.email })
    });

    // …puis tente l'ancien jeton prévisible base64url(email).
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ token: predictedToken(bruno.email), password: 'AttaquePassw0rd!' })
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/FLAG\{/);
  });

  it('régression sécurité : un jeton expiré est rejeté', async () => {
    const stack = makeStack();
    const app = await buildApp(stack.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const token = newToken();
    stack.resetTokens.set(tokenDigest(token), {
      user_id: bruno.id,
      expires_at: Date.now() - 1_000, // déjà expiré
      used_at: null
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ token, password: 'LegitPassw0rd!' })
    });
    expect(res.statusCode).toBe(400);
  });

  it('régression sécurité : un jeton déjà utilisé est rejeté à la seconde tentative', async () => {
    const stack = makeStack();
    const app = await buildApp(stack.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/request',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ email: alice.email })
    });
    const token = stack.mailbox.at(-1)!.resetToken;

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ token, password: 'FirstPassw0rd!' })
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ token, password: 'SecondPassw0rd!' })
    });
    expect(second.statusCode).toBe(400);
  });
});