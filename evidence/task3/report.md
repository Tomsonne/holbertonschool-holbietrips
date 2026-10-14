# A04 — Cryptographic Failures (Passport Storage)

## Vulnerability

Traveller passport numbers were protected with a `legacy-base64` mode that only base64-encoded the value and stored a literal marker (`passport_iv = 'legacy-base64'`) instead of encrypting it. Anyone with read access to the database could recover the plaintext passport without any key — no confidentiality, no integrity.

## Exploitation

Bruno's seeded profile stored `passport_ciphertext = 'RlItREVNTy1CUlVOTy04NzQy'` with `passport_iv = 'legacy-base64'`. Decoding it locally (`base64 -d`) yielded `FR-DEMO-BRUNO-8742` without any secret. Submitting that recovered value, authenticated as Bruno, to the local proof endpoint `POST /api/challenges/a04/claim` returned `FLAG{a04_0ae49374a1fd698761e11774}`.

## Root Cause

```ts
if (mode === 'legacy-base64') {
  return { ciphertext: Buffer.from(value).toString('base64'), iv: 'legacy-base64', tag: null };
}
```
Encoding was used where authenticated encryption (`encryptSensitive` / AES-256-GCM, already present in `security.ts`) should have been used.

## Remediation

- `config.ts` / `compose.yaml` / `.env.example`: default `PASSPORT_PROTECTION_MODE` to `aes-gcm`.
- `apps/api/src/migrate-passports.ts` (new): one-off script that re-encrypts every row still marked `legacy-base64` using `encryptSensitive`, so the pre-existing seeded record is migrated, not just future writes.
- `profile.ts`: removed the local proof endpoint `/api/challenges/a04/claim` entirely.

## Verification

Regression tests: the stored value contains no recoverable plaintext and carries an authentication tag; a tampered tag causes decryption to throw. Business test: an authorized encrypt/decrypt round-trip restores the original passport. Full suite passing — see `passing-tests.png`.