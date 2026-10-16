# A03 — Supply Chain Integrity (Destination Pack)

## Vulnerability

`loadDestinationPack()` calculait l'empreinte SHA-256 du fichier fourni, mais ne la comparait jamais à l'empreinte de référence avant d'analyser et de renvoyer son contenu. La route ajoutait un contrôle qui se contentait d'indiquer `accepted: true` au lieu de rejeter une différence ; elle servait donc toujours le jeu de données modifié. L'application était configurée pour charger la version altérée, tandis que l'empreinte de référence correspondait à la version approuvée. Cette différence était ignorée silencieusement : tout jeu de données falsifié pouvait être servi dans le catalogue public.

## Exploitation

`GET /api/destination-pack` renvoyait `integrity.expected` ≠ `integrity.calculated` tout en indiquant `accepted: true`. L'entrée `kyoto-saisons` contenait un conseil de voyage non approuvé avec le drapeau `FLAG{a03_9f6a0571f7956cacedf7de1b}`. Les mêmes données falsifiées étaient également exposées par `/api/trips`.

## Root Cause

```ts
const pack = JSON.parse(raw.toString('utf8')) as DestinationPack; // analysé avant la vérification
return { pack, integrity: { expected, calculated, accepted: true } }; // valeur codée en dur
```
`calculated` et `expected` n'étaient jamais comparés ; le contenu était analysé puis accepté sans condition.

## Remediation

- `destination-pack.ts` : comparer `calculatedSha256` à `expectedSha256` **avant** `JSON.parse` et lever une erreur si les valeurs diffèrent.
- `catalog.ts` : entourer l'appel au chargeur d'un bloc `try/catch` ; en cas d'échec, journaliser les détails côté serveur et renvoyer au client une erreur générique sans information sensible.
- `compose.yaml` / `.env.example` / `config.ts` : configurer l'application pour charger la version **approuvée**, avec l'empreinte correspondante.

## Verification

Test de régression : le jeu de données altéré est rejeté avant son analyse (l'espion sur `JSON.parse` n'est jamais appelé). Test métier : la version approuvée se charge avec une empreinte concordante. La suite complète de tests réussit — voir `passing-tests.png`.
