# A06 — Insecure Design (Coupon Stacking)

## Vulnerability

Le point de création des réservations acceptait un seul champ `couponCode` dans son interface et son contrat API, mais le serveur le découpait silencieusement sur les virgules et appliquait une réduction pour chaque code dans une boucle. Aucune règle n'imposait « au plus un coupon par réservation » : un client pouvait répéter ou cumuler des codes pour multiplier les réductions et abaisser le total sous le prix prévu.

## Exploitation

Une réservation avec un seul coupon `BIENVENUE10` servait de référence pour le prix. L'envoi de la même réservation (même voyage et même nombre de voyageurs) avec `couponCode: "BIENVENUE10,BIENVENUE10"` appliquait deux fois la réduction de 10 %, ce qui donnait un total inférieur et confirmait le cumul. Le champ `itinerary_notes` de la réponse de création contenait `FLAG{a06_<redacted>}` : ce drapeau figurait seulement dans cette réponse immédiate, sans être enregistré ni réaffiché lors de l'ouverture ultérieure de la réservation.

## Root Cause

```ts
const couponCodes = readText(body.couponCode, 120).toUpperCase().split(',').map(c => c.trim()).filter(Boolean);
...
for (const couponCode of couponCodes) {
  total = applyCoupon(total, { discountPercent: coupon.discount_percent, minimumCents: coupon.minimum_cents });
}
```
Aucune validation ne limitait `couponCodes` à une seule entrée : la règle métier manquait, même si la boucle fonctionnait comme prévu.

## Remediation

`bookings.ts` : la règle d'un seul coupon est désormais appliquée explicitement, avant toute écriture en base de données :
```ts
if (couponCodes.length > 1) {
  return reply.code(400).send({ error: 'Un seul coupon est autorisé par réservation' });
}
```
Ce contrôle est placé avant `pool.connect()`/`BEGIN` : une requête rejetée n'ouvre donc aucune transaction et ne modifie ni `bookings`, ni `coupons`, ni `trips`.

## Verification

Test de régression : des coupons cumulés ou dupliqués provoquent une réponse `400` sans drapeau ; `pool.connect` et `client.query` ne sont jamais appelés (aucune écriture). Tests métier : un coupon valide applique une seule réduction ; une réservation sans coupon est facturée au prix plein. La suite complète de tests réussit — voir `passing-tests.png`.
