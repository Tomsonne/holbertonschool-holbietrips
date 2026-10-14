import { describe, expect, it } from 'vitest';
import { encryptSensitive, protectPassport, revealPassport } from '../../apps/api/src/security';

const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const demoPassport = 'FR-DEMO-BRUNO-8742';

describe('A04 — Passport Panic', () => {
  it('security regression: stored passport is authenticated-encrypted, not just encoded', () => {
    const stored = protectPassport(demoPassport, key, 'aes-gcm');

    // Le mode legacy est abandonné : plus de marqueur base64
    expect(stored.iv).not.toBe('legacy-base64');
    expect(stored.tag).toBeTruthy();

    // Le texte clair n'apparaît ni tel quel, ni en base64, dans le stockage
    expect(stored.ciphertext).not.toContain(demoPassport);
    expect(Buffer.from(stored.ciphertext, 'base64').toString('utf8')).not.toBe(demoPassport);
  });

  it('security regression: tampered ciphertext is rejected', () => {
    const stored = encryptSensitive(demoPassport, key);

    // On falsifie le tag d'authentification
    const forgedTag = Buffer.from(stored.tag, 'base64');
    forgedTag[0] ^= 0xff;
    const tamperedTag = forgedTag.toString('base64');

    expect(() => revealPassport(stored.ciphertext, stored.iv, tamperedTag, key)).toThrow();
  });

  it('business: an authorised profile round-trip preserves the passport', () => {
    const stored = protectPassport(demoPassport, key, 'aes-gcm');
    const revealed = revealPassport(stored.ciphertext, stored.iv, stored.tag, key);
    expect(revealed).toBe(demoPassport);
  });
});