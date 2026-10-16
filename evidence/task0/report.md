# A01 — Boarding Pass Mix-Up

## Vulnerability

La route `GET /api/bookings/:id` renvoyait le détail complet de **n'importe quelle réservation**
à **n'importe quel client authentifié**, sans vérifier que celui-ci en était bien le propriétaire.
Un client pouvait ainsi lire le dossier de voyage d'un autre client (nom, email, destination,
statut de paiement) simplement en connaissant son identifiant de réservation.

## Exploitation

1. Connexion avec le compte client Alice Martin.
2. Récupération de l'identifiant d'une réservation d'un autre client (Bruno Dupont) via les données de
   démonstration : `40000000-0000-4000-8000-000000000002`.
3. Rejeu de la requête `GET /api/bookings/<id-de-bruno>` depuis la console du navigateur, avec
   le jeton d'authentification d'Alice.
4. La réponse renvoyait l'intégralité de la réservation de Bruno, avec le drapeau :
   `FLAG{a01_e4b26452e39635af582fa437}`.

## Root Cause

La route vérifiait seulement qu'un utilisateur était authentifié (`requireUser`), puis récupérait
la réservation uniquement par son `id`, sans filtrer par `user_id`. La fonction `canReadBooking`,
qui implémente pourtant déjà la règle d'accès correcte dans `apps/api/src/domain.ts`, n'était
jamais appelée dans le gestionnaire de la route.

## Remediation

Appel de `canReadBooking(user, booking.user_id)` avant de renvoyer la réservation : si
l'utilisateur n'est ni le propriétaire ni un compte `support`, la route renvoie `403 Accès refusé`
au lieu du détail de la réservation.

```ts

   if (!canReadBooking(request.authUser!, booking.user_id)) 
      {     return reply.code(403).send({ error: 'Accès refusé' });}
    return { booking };
```

## Verification

`tests/api/a01-booking-access.test.ts` mis à jour avec un test de régression (Alice → réservation
de Bruno → `403`, aucune donnée ni drapeau exposés) et deux tests métier positifs (Alice lit sa
propre réservation ; le support lit une réservation par son identifiant). Suite exécutée via
`docker compose run --rm --no-deps app npm test` — voir `passing-tests.png`.
