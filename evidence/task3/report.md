# A04 — Cryptographic Failures (Passport Storage)

## Vulnerability

Les numéros de passeport des voyageurs étaient protégés par un mode `legacy-base64` qui se contentait de les encoder en base64 et d'enregistrer un marqueur littéral (`passport_iv = 'legacy-base64'`) au lieu de les chiffrer. Toute personne ayant accès en lecture à la base de données pouvait retrouver le numéro en clair sans clé : ni la confidentialité ni l'intégrité n'étaient garanties.

## Exploitation

Le profil de démonstration de Bruno contenait `passport_ciphertext = 'RlItREVNTy1CUlVOTy04NzQy'` et `passport_iv = 'legacy-base64'`. Un décodage local (`base64 -d`) révélait `FR-DEMO-BRUNO-8742` sans aucun secret. L'envoi de cette valeur au point de validation local `POST /api/challenges/a04/claim`, avec une session authentifiée au nom de Bruno, renvoyait `FLAG{a04_0ae49374a1fd698761e11774}`.

## Root Cause

```ts
if (mode === 'legacy-base64') {
  return { ciphertext: Buffer.from(value).toString('base64'), iv: 'legacy-base64', tag: null };
}
```
Un simple encodage était utilisé à la place du chiffrement authentifié (`encryptSensitive` / AES-256-GCM), déjà disponible dans `security.ts`.

## Remediation

- `config.ts` / `compose.yaml` / `.env.example` : définir `aes-gcm` comme valeur par défaut de `PASSPORT_PROTECTION_MODE`.
- `apps/api/src/migrate-passports.ts` (nouveau) : ajouter un script ponctuel qui chiffre avec `encryptSensitive` chaque ligne encore marquée `legacy-base64`, afin de migrer aussi l'enregistrement de démonstration existant.
- `profile.ts` : supprimer entièrement le point de validation local `/api/challenges/a04/claim`.

## Verification

Tests de régression : la valeur stockée ne permet pas de retrouver le numéro en clair et comporte une étiquette d'authentification ; si cette étiquette est altérée, le déchiffrement échoue. Test métier : un cycle autorisé de chiffrement puis de déchiffrement restitue le numéro de passeport initial. La suite complète de tests réussit — voir `passing-tests.png`.
