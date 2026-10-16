# A07 — Identification and Authentication Failures (Reset Route Roulette)

## Vulnerability

L'étape de demande de réinitialisation produisait un jeton **déterministe et réversible** : un simple encodage base64url de l'adresse e-mail. Le même compte recevait donc toujours le même jeton, et ce jeton n'était qu'une représentation de l'adresse — sans aléa, sans secret, sans lien cryptographique avec le compte. Toute personne connaissant l'adresse d'un voyageur pouvait recalculer son jeton et confirmer une réinitialisation **sans jamais recevoir le mail**, détournant ainsi son parcours de reset.

## Exploitation

En déclenchant deux fois « Mot de passe oublié » pour la même adresse, le service de faux-mail déposait à chaque fois un jeton identique — confirmant le caractère déterministe. Décodé, ce jeton révélait l'adresse en clair (`base64url("alice.martin@example.test")` → `alice.martin@example.test`).

Contre le compte de démonstration `bruno.dupont@example.test`, l'attaque se faisait en deux temps, sans accès à sa boîte mail : d'abord un appel public à `/api/auth/password-reset/request` (réponse générique, aucune authentification) pour ouvrir un reset en attente côté serveur ; puis un appel à `/api/auth/password-reset/confirm` avec le jeton **prédit** `base64url(email)` et un nouveau mot de passe. La réponse de confirmation renvoyait `FLAG{a07_ff1a079019470636755f2c35}` — drapeau présent uniquement dans cette réponse immédiate, sans être enregistré. Capture : `flag-confirm.png`.

## Root Cause

```ts
// apps/api/src/security.ts
export const legacyResetToken = (email: string) => Buffer.from(email.toLowerCase(), 'utf8').toString('base64url');

// apps/api/src/routes/auth.ts — /api/auth/password-reset/request
const resetToken = legacyResetToken(account.email);
```
Le jeton était dérivé de la seule adresse e-mail. Le stockage était pourtant déjà correct — haché en base (`tokenDigest`), lié à l'`user_id`, expirant à 15 minutes et à usage unique via `used_at` — mais ces protections étaient vaines puisque le jeton lui-même était prévisible : un helper de jeton aléatoire (`newToken = randomBytes(32)`) existait déjà dans le même fichier mais n'était pas utilisé pour le reset.

## Remediation

`security.ts` : suppression du helper hérité `legacyResetToken`.

`auth.ts` : la demande de réinitialisation génère désormais un jeton **cryptographiquement aléatoire** via le helper existant, réutilisant toute la chaîne de stockage déjà sûre :
```ts
const resetToken = newToken(); // randomBytes(32).toString('base64url')
```
Le jeton obtenu est aléatoire (256 bits), haché avant stockage, lié au compte (`user_id`), à durée de vie courte (15 min) et à usage unique (`used_at`) ; les sessions existantes sont révoquées après confirmation (`DELETE FROM sessions WHERE user_id=$1`). La réponse pédagogique exposant le drapeau a également été retirée du handler de confirmation, qui renvoie désormais uniquement `{ ok: true }`. Le jeton n'est jamais exposé par l'API de demande : il n'est consultable que via le service interne de faux-mail.

## Verification

Tests de régression : un jeton **prédit** depuis l'e-mail, un jeton **expiré** et un jeton **déjà utilisé** provoquent chacun une réponse `400` sans drapeau. Test métier positif : un parcours de reset HTTP complet aboutit (`{ ok: true }`) en utilisant le vrai jeton aléatoire récupéré dans le service de faux-mail — prouvant qu'une réinitialisation légitime fonctionne toujours. Un test de helper vérifie que `newToken()` est imprévisible et de forte entropie. En manuel, l'attaque par jeton prédit contre Bruno est désormais rejetée (`400`, voir `rejected-after-fix.png`). La suite complète de tests réussit — voir `passing-tests.png`. Les données de démonstration (mot de passe de Bruno) sont restaurées par re-seed avant réutilisation des identifiants d'origine.