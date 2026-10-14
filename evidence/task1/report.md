# A02 — The Debug Desk Left Open

## Vulnerability

Le point de diagnostic interne `GET /api/support/diagnostics` était accessible à **n'importe
quel compte client authentifié**, pas seulement au personnel support, dès que le réglage
runtime `SUPPORT_DIAGNOSTICS_ENABLED` était actif. Son chemin était en plus révélé à tout le
monde via un header de réponse (`x-holbietrips-debug-desk`) ajouté à **toutes** les réponses de
l'API dès que ce réglage était actif, y compris sur des routes publiques comme `/api/trips`.

## Exploitation

1. Connexion avec un compte client ordinaire (Alice Martin).
2. Inspection des en-têtes de réponse de n'importe quelle requête API dans DevTools : présence
   du header `x-holbietrips-debug-desk: /api/support/diagnostics`, révélant l'existence et le
   chemin exact d'une fonctionnalité interne non documentée côté client.
3. Appel direct de `GET /api/support/diagnostics` avec le jeton d'authentification du client.
4. La réponse renvoyait des informations internes (configuration runtime, services internes,
   une note opérateur) ainsi que le flag : `FLAG{a02_4302d6d0243aa43dfd1db8eb}`.

## Root Cause

Deux défaillances combinées :

- **Réglage runtime permissif** : `config.supportDiagnosticsEnabled` conditionnait uniquement
  l'enregistrement de la route, sans qu'aucune vérification de rôle ne protège l'accès une fois
  la route enregistrée.
- **Décision d'autorisation manquante côté serveur** : dans `apps/api/src/routes/system.ts`,
  la route était enregistrée sans `preHandler` de contrôle de rôle — toute session authentifiée,
  quel que soit le rôle du compte, pouvait l'appeler.

Une session client valide suffisait donc à elle seule : l'authentification n'est pas
l'autorisation, et aucune des deux couches (réglage runtime, contrôle de rôle) ne bloquait
réellement un compte `customer`.

## Remediation

Ajout d'un contrôle de rôle explicite sur la route, indépendant du réglage runtime :

```ts
app.get('/api/support/diagnostics', { preHandler: context.requireRole('support') }, async () => ({
  ...
}));
```

Avec `requireRole('support')`, un compte `customer` reçoit désormais `403 Accès refusé` même si
`diagnosticsEnabled` est réactivé par erreur — la protection ne dépend plus uniquement du
réglage runtime, mais d'une vérification explicite à chaque requête.

## Verification

`tests/api/a02-security-misconfiguration.test.ts` mis à jour avec un test de régression (client
authentifié, diagnostics activés → `403`, aucun flag exposé) et deux tests métier positifs (le
support peut toujours ouvrir le Debug Desk quand il est activé ; le catalogue public reste
accessible et la route diagnostics renvoie `404` quand les diagnostics sont désactivés). Suite
complète exécutée via `docker compose run --rm --no-deps app npm test` — 14 fichiers de test,
33 tests, tous passants (`passing_test.png`).