# A03 — The Mystery Destination Pack

**Catégorie OWASP :** A03:2025 — Software Supply Chain Failures (intégrité d'un artefact importé)
**Composants :** `apps/api/src/destination-pack.ts`, `apps/api/src/routes/catalog.ts`, `apps/api/src/config.ts`, `compose.yaml`, `.env.example`
**Flag récupéré :** `FLAG{a03_9f6a0571f7956cacedf7de1b}`

---

## 1. Résumé

L'API HolbieTrips importe un « Destination Pack » (fichier JSON fourni par le fournisseur fictif HolbieTripsSync) pour enrichir le catalogue avec des conseils de voyage. La configuration fournit une empreinte SHA-256 attendue, mais le chargeur se contentait de **calculer** l'empreinte puis de **parser et utiliser le contenu quoi qu'il arrive**, en renvoyant `accepted: true` en dur. Le runtime pointait en plus vers le pack altéré : un conseil non approuvé pour Kyoto était donc servi aux clients.

Après correction, le pack est vérifié **avant** tout `JSON.parse`, un pack non conforme lève une erreur, le client reçoit une réponse générique non sensible, et le runtime ainsi que les tests utilisent le pack approuvé.

## 2. Analyse

### 2.1 Les deux packs fournis

| Fichier | SHA-256 calculé | Conseil Kyoto |
|---|---|---|
| `database/fixtures/destination-pack-approved.json` | `78f5ba6c78041a2f7cff89ad032c5df7a5a03c9dddbe63150d7ca2d23be4bc93` | « Visit the eastern temples early for a quieter walk. » |
| `database/fixtures/destination-pack-altered.json` | `18f54fe1f704ee8cdc68273bdc0071749a8a90c76a7ee6e3dafa20cd8ba996cd` | « Unofficial night route accepted by the altered destination pack. » |

Le pack altéré porte aussi `packVersion: "2027.1-unofficial"` au lieu de `"2027.1"`.

### 2.2 Configuration

- `compose.yaml` : `DESTINATION_PACK_FILE` pointait vers `destination-pack-altered.json`, alors que `DESTINATION_PACK_SHA256` contenait l'empreinte du pack **approuvé** (`78f5ba6c…`).
- `apps/api/src/config.ts` et `.env.example` : la valeur par défaut était également le pack altéré.

L'empreinte attendue et le fichier chargé ne correspondaient donc pas — la vérification aurait dû échouer.

### 2.3 Cause racine — le chargeur (`destination-pack.ts`)

```ts
const raw = await readFile(file);
const calculatedSha256 = createHash('sha256').update(raw).digest('hex');
const pack = JSON.parse(raw.toString('utf8')) as DestinationPack;   // parsé sans vérification
return { pack, integrity: { expected, calculated, accepted: true } }; // « accepté » en dur
```

- Les deux empreintes sont calculées et exposées, mais **jamais comparées**.
- `accepted: true` est une étiquette, pas un contrôle (« a label is not a lock »).
- Le contenu est parsé et consommé avant toute décision de confiance.

La route (`catalog.ts`) détectait bien la différence (`calculated !== expected && accepted`) mais, au lieu de refuser, elle continuait à servir le pack — et c'est là que le flag était ajouté au conseil de Kyoto.

## 3. Exploitation (preuve)

`GET http://127.0.0.1:8080/api/destination-pack` avec la configuration d'origine :

- `integrity.expected` = `78f5ba6c…`, `integrity.calculated` = `18f54fe1…` → **empreintes différentes**
- `integrity.accepted` = `true`
- `kyoto-saisons.travelTip` = conseil non approuvé + `FLAG{a03_9f6a0571f7956cacedf7de1b}`

Le même pack alimente `/api/trips` (`travel_tip`), donc le contenu non approuvé atteignait aussi le catalogue public.

> 📸 Capture 1 : flag visible dans la réponse `/api/destination-pack` (DevTools → Réseau).

## 4. Correction

### 4.1 `apps/api/src/destination-pack.ts` — vérifier avant de consommer

```ts
const raw = await readFile(file);
const calculatedSha256 = createHash('sha256').update(raw).digest('hex');
if (calculatedSha256 !== expectedSha256) {
  throw new Error(`Destination pack integrity check failed for ${file}: expected ${expectedSha256}, got ${calculatedSha256}`);
}
const pack = JSON.parse(raw.toString('utf8')) as DestinationPack;
```

La comparaison a lieu sur les octets bruts, avant le parsing. Si on atteint le `return`, `accepted: true` est désormais vrai par construction. Le message d'erreur détaillé (chemin, empreintes) est destiné aux logs serveur uniquement.

### 4.2 `apps/api/src/routes/catalog.ts` — échouer proprement

- Suppression du bloc `if (calculated !== expected && accepted)` qui servait le pack non conforme.
- `getDestinationPack` encapsule le chargement dans un `try/catch` : l'erreur détaillée est journalisée (`app.log.error`), puis une erreur **générique** est relancée.

```ts
const getDestinationPack = async () => {
  try {
    return await loadDestinationPack(settings.destinationPackFile, settings.destinationPackSha256);
  } catch (error) {
    app.log.error({ err: error }, 'Destination pack rejected');
    throw Object.assign(new Error('Les conseils de voyage sont temporairement indisponibles'), { statusCode: 503 });
  }
};
```

Les deux routes (`/api/destination-pack`, `/api/trips`) sont inchangées. Le gestionnaire d'erreurs global de l'application renvoie au client `500 {"error":"Une erreur interne est survenue"}` : aucun chemin, aucune empreinte, aucune stack trace, aucun contenu du pack altéré.

### 4.3 Configuration — pointer vers le pack approuvé

- `compose.yaml` :
  ```yaml
  DESTINATION_PACK_FILE: /workspace/database/fixtures/destination-pack-approved.json
  DESTINATION_PACK_SHA256: 78f5ba6c78041a2f7cff89ad032c5df7a5a03c9dddbe63150d7ca2d23be4bc93
  ```
- `apps/api/src/config.ts` : valeur par défaut → `destination-pack-approved.json` (utilisée par les autres tests du catalogue).
- `.env.example` : même changement.

L'empreinte attendue a été vérifiée indépendamment avec `sha256sum` sur le fichier approuvé.

## 5. Tests — `tests/api/a03-supply-chain.test.ts`

| Test | Type | Ce qu'il prouve |
|---|---|---|
| `rejects an altered pack before parsing it (security regression)` | Sécurité | Le pack **altéré**, passé explicitement avec l'empreinte approuvée en dur, est rejeté et `JSON.parse` n'est jamais appelé. Ne dépend pas de la configuration par défaut. |
| `serves the approved pack through the catalogue endpoint without any flag` | Métier | Avec la configuration corrigée, `/api/destination-pack` répond 200, l'empreinte calculée est celle approuvée, aucun flag. |
| `preserves the positive path for the approved pack` | Métier | Le pack **approuvé** se charge, empreinte conforme, fournisseur `HolbieTripsSync`. |

L'ancien test « characterizes the flaw » (qui attendait l'acceptation du pack altéré) a été remplacé par la régression de sécurité.

Résultat : `docker compose run --rm --no-deps app npm test` → **14 fichiers, tous les tests passent**.

> 📸 Capture 2 : même requête avec le pack altéré configuré après correction → réponse générique `{"error":"Une erreur interne est survenue"}`, sans flag.
> 📸 Capture 3 : suite de tests complète au vert.

## 6. Vérification

| Condition de l'énoncé | Statut |
|---|---|
| Pack altéré rejeté avant parsing ou utilisation | ✅ comparaison avant `JSON.parse`, testé avec un spy |
| Pack approuvé chargé via les deux endpoints du catalogue | ✅ `/api/destination-pack` et `/api/trips` répondent 200 avec le conseil approuvé |
| Échec = réponse non sensible | ✅ message générique, détails uniquement dans les logs |
| Test de sécurité + test métier | ✅ 1 régression + 2 tests positifs |
| Runtime et autres tests configurés sur le pack approuvé | ✅ `compose.yaml`, `config.ts`, `.env.example` |

## 7. Remarques

- **Principe retenu :** une empreinte n'a de valeur que si elle conditionne l'usage. Calculer, afficher ou étiqueter (`accepted`) ne protège rien ; il faut comparer puis refuser *avant* de consommer.
- **Hors périmètre, constaté :** le front (`localhost:8000`) plante en page blanche si `/api/trips` ne renvoie pas `{ trips: [...] }`. Une dégradation gracieuse (voyages servis avec `travel_tip: null` si le pack est indisponible) améliorerait la disponibilité.
- **Hors périmètre (A05) :** le filtre de recherche de `/api/trips` est construit par concaténation SQL ; il relève du challenge d'injection et n'a pas été modifié ici.