# A05 — SQL Injection (Trip Search)

## Vulnerability

Le paramètre de recherche `q` de `GET /api/trips` était concaténé directement dans la clause SQL `WHERE` au lieu d'être lié comme paramètre de requête. Un attaquant pouvait ainsi modifier la logique de la requête et contourner le filtre `is_published=true`.

## Exploitation

Une simple apostrophe (`?q='`) provoquait une erreur `500`, montrant que la saisie sortait de la chaîne SQL. Dans la requête (`is_published=true AND (title ILIKE '%<q>%' OR ...)`), la charge `%') OR (title ILIKE '%` fermait la chaîne et la parenthèse ouverte, puis ajoutait une branche `OR` qui correspondait à toutes les lignes. Elle révélait ainsi le voyage interne non publié `archive-search-party`, dont la description contenait `FLAG{a05_f18576d329621a5302236616}`.

## Root Cause

```ts
const filter = query
  ? ` AND (title ILIKE '%${query}%' OR destination ILIKE '%${query}%' OR description ILIKE '%${query}%')`
  : '';
```
La saisie de l'utilisateur était insérée dans le texte SQL au lieu d'être transmise comme donnée.

## Remediation

`catalog.ts` : la valeur recherchée est désormais liée à `$1` et transmise à `pool.query` dans un tableau `params` distinct ; le texte SQL reste constant :
```ts
const filter = query ? ` AND (title ILIKE $1 OR destination ILIKE $1 OR description ILIKE $1)` : '';
const params = query ? [`%${query}%`] : [];
```

## Verification

Tests de régression : le SQL transmis à `pool.query` ne contient plus la condition injectée et utilise `$1` ; la charge d'injection ne renvoie plus ni le voyage non publié ni le drapeau. Test métier : une recherche ordinaire (`Kyoto`) renvoie toujours le voyage correspondant. La suite complète de tests réussit — voir `passing-tests.png`.
