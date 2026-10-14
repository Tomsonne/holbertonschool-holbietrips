# A05 — Search Party Crasher

**Catégorie OWASP :** A03:2021 / A05 (laboratoire) — Injection (SQL)
**Composant :** `apps/api/src/routes/catalog.ts`
**Flag récupéré :** `FLAG{a05_f18576d329621a5302236616}`

---

## 1. Résumé

La barre de recherche du catalogue (`GET /api/trips?q=…`) construisait sa requête PostgreSQL par **concaténation de chaînes** : la valeur saisie par l'utilisateur était recollée directement dans le SQL. Une saisie contenant une apostrophe permettait de sortir de la chaîne et de réécrire le prédicat `WHERE`, donc de contourner le filtre `is_published=true` et de faire apparaître un voyage interne non publié (`archive-search-party`), porteur du flag.

Après correction, la valeur de recherche est transmise comme **paramètre lié** (`$1`). PostgreSQL reçoit la structure de la requête et la valeur séparément ; la saisie n'est plus jamais interprétée comme du SQL. La recherche normale fonctionne toujours et le voyage non publié reste caché.

## 2. Analyse

### 2.1 Du champ de recherche à la requête

La route `/api/trips` lit le paramètre `q`, puis construit :

```ts
const filter = query
  ? ` AND (title ILIKE '%${query}%' OR destination ILIKE '%${query}%' OR description ILIKE '%${query}%')`
  : '';
await pool.query(
  `SELECT ... FROM trips
   WHERE is_published=true${filter}
   ORDER BY departure_date`
);
```

La requête résultante a la forme :

```sql
WHERE is_published=true AND (title ILIKE '%<q>%' OR destination ILIKE '%<q>%' OR description ILIKE '%<q>%')
```

Le filtre de publication (`is_published=true`) et le groupe de recherche sont reliés par `AND`. `<q>` est la saisie de l'utilisateur, insérée telle quelle à l'intérieur des chaînes `'%...%'`.

### 2.2 Cause racine

`<q>` étant concaténé sans échappement ni binding, une apostrophe referme la chaîne SQL et tout ce qui suit est interprété comme du code. On peut alors ajouter une condition toujours vraie liée par `OR`, ce qui neutralise le `AND (…)` et fait remonter toutes les lignes, publiées ou non.

## 3. Exploitation (preuve)

Démarche, sans connaître l'URL à l'avance :

1. **Repérer l'injection.** `?q='` (une apostrophe seule) renvoie une erreur **500** : la saisie casse la syntaxe SQL, donc elle est bien interprétée comme du code.
2. **Lire la requête** (`catalog.ts`) pour voir la structure `is_published=true AND (… ILIKE '%<q>%' …)`.
3. **Fabriquer la charge** qui rend la condition toujours vraie et referme proprement la parenthèse ouverte après le `AND` :

```
%') OR (title ILIKE '%
```

Une fois insérée, le prédicat devient `is_published=true AND (… '%%') OR (title ILIKE '%%' …)`, vrai pour toutes les lignes.

Vérification :

```
curl -s --get "http://localhost:8080/api/trips" --data-urlencode "q=%') OR (title ILIKE '%" | grep -i flag
```

Le voyage interne `archive-search-party` (« Dossier interne — ne pas publier ») apparaît, avec `FLAG{a05_f18576d329621a5302236616}` dans sa description.

> 📸 Capture 1 : réponse de `/api/trips` montrant le voyage non publié et son flag.

## 4. Correction

Dans `apps/api/src/routes/catalog.ts`, la concaténation est remplacée par un **paramètre lié** :

```ts
const filter = query
  ? ` AND (title ILIKE $1 OR destination ILIKE $1 OR description ILIKE $1)`
  : '';
const params = query ? [`%${query}%`] : [];
const result = await pool.query(
  `SELECT id,slug,title,destination,description,departure_date,return_date,price_cents,seats_available,image_key
   FROM trips
   WHERE is_published=true${filter}
   ORDER BY departure_date`,
  params
);
```

Ce qui change : la valeur de recherche part dans le tableau `params` comme `$1`, séparée du texte SQL. Le driver `pg` l'envoie à PostgreSQL comme une donnée, jamais comme du code. L'apostrophe n'a plus d'effet syntaxique. Le `%...%` reste dans le paramètre, donc le `ILIKE` continue de fonctionner. Le fragment `${filter}` ne contient désormais que du SQL fixe (`$1`), sans aucune donnée utilisateur. Le filtre `is_published=true` n'est plus contournable.

Vérification après correction :

| Requête | Avant | Après |
|---|---|---|
| `q='` (apostrophe) | 500 Internal Server Error | 200, `{"trips":[]}` |
| `q=%') OR (title ILIKE '%` | 5 voyages + flag | 4 voyages publiés, aucun flag |
| `q=Kyoto` | voyage de Kyoto | voyage de Kyoto (inchangé) |

> 📸 Capture 2 : la même injection renvoie 200 sans voyage non publié ni flag (un résultat vide est également valide).

## 5. Tests — `tests/api/a05-injection.test.ts`

Le test « characterizes the flaw » (qui attendait le flag) a été remplacé, puisque l'injection ne doit plus aboutir.

| Test | Type | Ce qu'il prouve |
|---|---|---|
| search input is bound as a parameter, not concatenated | Sécurité | Le SQL transmis à `pool.query` ne contient pas la charge (`OR 1=1`) mais utilise `$1`, et la charge est passée dans les paramètres liés. |
| the injection no longer leaks the unpublished trip or its flag | Sécurité | Avec la charge d'injection, la réponse ne contient ni `FLAG{a05_` ni `archive-search-party`. |
| an ordinary destination search still works | Métier | `?q=Kyoto` renvoie bien le voyage de Kyoto. |

Résultat : `docker compose run --rm --no-deps app npm test` → **14 fichiers, 36 tests, tous au vert**.

> 📸 Capture 3 : suite de tests complète au vert.

## 6. Vérification des conditions d'atterrissage

| Condition de l'énoncé | Statut |
|---|---|
| Toutes les valeurs de recherche sont paramétrées | ✅ `$1` + tableau `params` |
| Le voyage caché reste caché | ✅ l'injection ne le révèle plus |
| La recherche normale du catalogue fonctionne | ✅ `q=Kyoto` inchangé |
| 1 test sécurité + 1 test métier | ✅ 2 tests sécurité + 1 test métier |

## 7. Remarques

- **Principe retenu :** séparer la question de ses valeurs. Un paramètre lié garantit que la saisie ne peut jamais modifier la structure de la requête, quelle que soit sa forme — contrairement à l'échappement manuel, fragile et facile à oublier.
- Le garde-fou existant `if (query.includes(';'))` a été laissé en place, mais ce n'est pas lui qui protège : seule la paramétrisation le fait. Les injections de ce challenge n'utilisaient d'ailleurs pas de `;`.