# A06 — Coupon Carousel

**Catégorie OWASP :** A04:2021 / A06 (laboratoire) — Insecure Design (règle métier manquante)
**Composant :** `apps/api/src/routes/bookings.ts`
**Flag récupéré :** `FLAG{a06_3d878a905a21191fe1eba16c}`

---

## 1. Résumé

L'interface de réservation demande « un code promo » (un champ unique). Côté serveur, ce champ `couponCode` était découpé sur les virgules en une **liste** de codes, puis une boucle appliquait une réduction **pour chaque** code. En envoyant plusieurs codes — ou le même répété — dans ce seul champ, un client cumulait les réductions et faisait descendre le total sous le prix prévu. La règle métier attendue (« zéro ou un coupon par réservation ») n'était écrite nulle part dans le code : c'est un défaut de conception, pas un bug d'implémentation isolé.

Après correction, la règle est explicitement vérifiée **avant** tout traitement : plus d'un code → rejet immédiat, sans écriture en base. Une réservation à zéro ou un coupon continue de fonctionner normalement.

## 2. Analyse

### 2.1 Le champ devient une collection

Dans `POST /api/bookings` :

```ts
const couponCodes = readText(body.couponCode, 120)
  .toUpperCase()
  .split(',')            // le séparateur accepté est la virgule
  .map(code => code.trim())
  .filter(Boolean);
```

Le champ unique saisi par l'utilisateur est transformé en tableau par `split(',')`. L'interface parle d'« un code », mais le backend accepte une liste.

### 2.2 La boucle applique une réduction par code

```ts
for (const couponCode of couponCodes) {
  // ... recherche du coupon ...
  total = applyCoupon(total, { discountPercent: coupon.discount_percent, minimumCents: coupon.minimum_cents });
  await client.query('UPDATE coupons SET uses=uses+1 WHERE id=$1', [coupon.id]);
}
```

Chaque passage retire une réduction du total. Rien ne limite le nombre d'itérations ni ne vérifie l'unicité. Le code reconnaît d'ailleurs lui-même le cas anormal : si `couponCodes.length > 1`, il enregistre la note `Coupon carousel accepted.` et ajoute le flag A06 **à la réponse immédiate uniquement** (le flag n'est pas stocké en base).

### 2.3 Cause racine

Aucune règle métier n'arbitre le cas « plusieurs coupons arrivent ensemble ». La validation portait sur le trip et le nombre de voyageurs, jamais sur le nombre de coupons. C'est une faille de conception (A06 / Insecure Design) : le comportement sûr n'a jamais été défini.

## 3. Exploitation (preuve)

Baseline puis attaque, même trip et même nombre de voyageurs (« a lower total alone is not proof »).

1. **Baseline (1 coupon).** Réservation sur « Au fil des fjords » / Lisbonne, 1 voyageur, coupon `BIENVENUE10`. Une seule réduction de 10 % est appliquée.
2. **Attaque (coupon répété).** Même réservation, mais `couponCode = "BIENVENUE10,BIENVENUE10"`. La réduction de 10 % est appliquée **deux fois**, le total descend sous la baseline.

La réponse immédiate du `POST /api/bookings` contient alors `itinerary_notes` avec `FLAG{a06_…}`. Rouvrir la réservation (`GET /api/bookings/:id`) n'affiche que `Coupon carousel accepted.` : le flag n'est pas persisté.

> 📸 Capture 1 : flag dans la réponse immédiate de création (DevTools → Réseau → `bookings` → Réponse), jeton d'authentification masqué.

## 4. Correction

La règle est énoncée et appliquée **avant** d'ouvrir la transaction, dans `apps/api/src/routes/bookings.ts` :

```ts
if (couponCodes.length > 1) {
  return reply.code(400).send({ error: 'Un seul coupon est autorisé par réservation' });
}
```

Placée juste après la construction de `couponCodes` et la validation du trip/voyageurs, cette vérification intervient avant `pool.connect()` et `BEGIN`. Conséquences :

- **Zéro coupon :** boucle vide, prix plein.
- **Un coupon :** une seule réduction appliquée.
- **Deux coupons ou plus :** `400`, aucune transaction, aucune écriture (ni `bookings`, ni `coupons.uses`, ni `trips.seats_available`).

Le pricing reste entièrement calculé côté serveur. Le bloc `hasMultipleCoupons` (note « carousel » + flag) devient inatteignable.

> 📸 Capture 2 : la même tentative à deux coupons renvoie `400 {"error":"Un seul coupon est autorisé par réservation"}`, sans flag.

## 5. Tests — `tests/api/a06-insecure-design.test.ts`

Le test « characterizes the flaw » (qui attendait 201 + flag) a été remplacé.

| Test | Type | Ce qu'il prouve |
|---|---|---|
| stacked/duplicate coupons are rejected before any write | Sécurité | Deux codes → `400`, pas de flag, et `pool.connect` / `client.query` ne sont jamais appelés : aucune écriture. |
| a single valid coupon is applied once | Métier | Un coupon valide applique une seule réduction (90000 sur une base de 100000 à 10 %). |
| a booking without any coupon pays full price | Métier | Sans coupon, le total est le prix plein (100000). |

Résultat : `docker compose run --rm --no-deps app npm test` → **14 fichiers, 37 tests, tous au vert**.

> 📸 Capture 3 : suite de tests complète au vert.

## 6. Vérification des conditions d'atterrissage

| Condition de l'énoncé | Statut |
|---|---|
| Au plus un coupon éligible affecte une réservation | ✅ `couponCodes.length > 1` rejeté |
| Les codes dupliqués ou cumulés sont rejetés | ✅ `400` avant traitement |
| Le pricing reste côté serveur | ✅ total calculé dans la route |
| 1 test sécurité + 1 test métier | ✅ 1 test sécurité + 2 tests métier |
| Rejet sans écriture | ✅ transaction jamais ouverte, vérifié par les mocks |

## 7. Remarques

- **Principe retenu :** l'invite n'est pas la politique. Le fait que l'UI n'affiche qu'un champ ne garantit rien ; la règle « un seul coupon » doit être explicite et appliquée côté serveur, avant tout traitement.
- Le découpage `split(',')` est conservé : il permet toujours de détecter une saisie multiple pour la rejeter proprement, plutôt que de la traiter.