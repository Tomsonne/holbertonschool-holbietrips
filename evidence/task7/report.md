# A08 — Software and Data Integrity Failures (Payment Postcard Pretender)

## Vulnerability

HolbieTrips expose deux entrées de paiement. Le checkout `/api/bookings/:id/pay` appelle le simulateur, reçoit une réponse **signée** (HMAC-SHA256 avec la clé de service partagée) et vérifie cette signature avant de confirmer. La seconde entrée, `/api/payments/callback`, destinée aux notifications du fournisseur, ne vérifiait **aucune signature** : elle se contentait de contrôler la forme du message, l'existence de la réservation et la concordance du montant. Or un montant correct et un identifiant valide prouvent seulement que les champs *collent*, pas **qui** a envoyé le message. N'importe quel appelant pouvait donc affirmer « cette réservation est payée » et faire changer l'état de la réservation sans qu'aucun fournisseur de confiance n'ait authentifié la notification.

## Exploitation

Le format exact du message se lit dans le handler lui-même : `bookingId`, `amountCents`, `status: "approved"`, `providerReference` (≥ 5 caractères) et `cardLast4` (4 chiffres). Pour la réservation de démonstration encore payable de Bruno (`HT-BRUNO-001`, id `40000000-0000-4000-8000-000000000002`, `total_cents = 129900`), une simple requête `POST /api/payments/callback` **non signée** portant ces champs était acceptée : la réservation passait de `pending` à `confirmed` et la réponse renvoyait `FLAG{a08_7ac131de5440c27003ff71e9}`. Aucune authentification, aucune signature, aucune clé de service n'étaient nécessaires. Capture : `flag-callback.png`.

## Root Cause

```ts
// apps/api/src/routes/payments.ts — /api/payments/callback (avant)
const validPayload = isUuid(bookingId)
  && Number.isInteger(amountCents)
  && status === 'approved'
  && providerReference.length >= 5
  && /^\d{4}$/.test(cardLast4);
if (!validPayload) return reply.code(400).send({ error: 'Confirmation invalide' });
// ... puis confirmation directe, SANS vérification de signature
await client.query(`UPDATE bookings SET status='confirmed' WHERE id=$1`, [bookingId]);
return { status: 'confirmed', flag: context.flags.get('A08') };
```
Le handler ne faisait jamais appel à `validSignature()`, contrairement au checkout qui l'utilisait déjà. Le même écart permettait aussi le rejeu : l'`UPDATE` confirmait la réservation sans exiger qu'elle soit encore `pending`.

## Remediation

`payments.ts` : le callback exige désormais une signature HMAC valide sur un payload canonique **avant tout changement d'état**, en réutilisant le contrôle de signature existant (`validSignature`) et la même clé de service (`settings.paymentKey`) que le checkout :
```ts
const signature = readText(body.signature, 128);
const signedFields = { bookingId, amountCents, status, providerReference, cardLast4 };
if (!validSignature(signedFields, signature, settings.paymentKey)) {
  await recordAudit(pool, null, 'payment.callback_rejected', 'booking', bookingId, {
    reason: 'invalid-signature'
  });
  return reply.code(401).send({ error: 'Signature de paiement invalide' });
}
```
L'ordre des champs du payload canonique reproduit exactement celui signé par le simulateur. Une garde anti-rejeu a été ajoutée à la confirmation (`UPDATE bookings SET status='confirmed' WHERE id=$1 AND status='pending'`), de sorte qu'un message rejoué sur une réservation déjà confirmée ne change plus rien. La réponse pédagogique exposant le drapeau a été retirée : le handler renvoie uniquement `{ status: 'confirmed' }`. Le checkout normal reste inchangé.

## Verification

Tests de régression : un callback **non signé** (`401`), **altéré** après signature (`401`), au **montant non concordant** mais correctement signé (`404`), et **rejoué** sur une réservation déjà confirmée (`404`) sont tous rejetés, et chacun préserve l'état antérieur de la réservation et du paiement. Test métier positif : un callback **correctement signé** confirme bien la réservation (`{ status: 'confirmed' }`, sans drapeau). Le checkout normal continue de fonctionner (le simulateur signe, l'API vérifie). En manuel, l'attaque non signée contre Bruno est désormais rejetée (`401`, voir `rejected-after-fix.png`). La suite complète de tests réussit — voir `passing-tests.png`. La réservation de démonstration de Bruno est restaurée à l'état `pending` avant toute nouvelle tentative.