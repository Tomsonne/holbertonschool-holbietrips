# A04 — Passport Panic

**Catégorie OWASP :** A04:2025 — Cryptographic Failures (données sensibles au repos)
**Composants :** `apps/api/src/security.ts`, `apps/api/src/routes/profile.ts`, `apps/api/src/config.ts`, `apps/api/src/migrate-passports.ts`, `compose.yaml`, `.env.example`
**Flag récupéré :** `FLAG{a04_0ae49374a1fd698761e11774}`

---

## 1. Résumé

Le service de profil prétend « mémoriser » le numéro de passeport des voyageurs. En réalité, la valeur stockée dans `traveler_profiles` n'était pas chiffrée mais seulement **encodée en base64**. N'importe qui disposant d'une copie de la base pouvait la décoder sans aucune clé. La menace visée est la confidentialité des **données au repos** : un attaquant lisant la base, mais ne possédant pas la clé de l'application, ne devrait rien pouvoir en tirer.

Après correction, les passeports — y compris l'enregistrement hérité déjà présent — sont protégés par du chiffrement authentifié AES-256-GCM. La donnée n'est plus récupérable sans la clé, toute altération est rejetée, et la lecture/mise à jour autorisée du profil fonctionne toujours. L'endpoint de preuve local a été supprimé.

## 2. Analyse

### 2.1 Champs de persistance

Table `traveler_profiles` (`database/migrations/001_initial.sql`) : `passport_ciphertext`, `passport_iv`, `passport_tag`. La route `apps/api/src/routes/profile.ts` relie le champ `passportNumber` de l'écran à ces trois colonnes.

### 2.2 L'enregistrement piégé

Le seed (`database/seeds/001_demo.sql`) insère pour Bruno Dupont :

```
passport_ciphertext = 'RlItREVNTy1CUlVOTy04NzQy'
passport_iv         = 'legacy-base64'
```

Le profil d'Alice a un passeport `NULL` : c'est donc celui de Bruno qui contient la donnée exploitable (« choisis le profil qui contient réellement un passeport »).

### 2.3 Cause racine — le « marqueur » legacy (`security.ts`)

```ts
export function protectPassport(value, keyHex, mode) {
  if (mode === 'legacy-base64') {
    return { ciphertext: Buffer.from(value).toString('base64'), iv: 'legacy-base64', tag: null };
  }
  return encryptSensitive(value, keyHex);  // AES-256-GCM, déjà disponible
}

export function revealPassport(ciphertext, iv, tag, keyHex) {
  if (iv === 'legacy-base64') return Buffer.from(ciphertext, 'base64').toString('utf8');
  ...
}
```

Le mode actif était `PASSPORT_PROTECTION_MODE=legacy-base64`. L'IV `legacy-base64` n'est pas un vecteur d'initialisation : c'est un marqueur qui dit à `revealPassport` de simplement décoder du base64. Il n'y a ni clé, ni tag, ni confidentialité. Les helpers de chiffrement authentifié (`encryptSensitive` / `decryptSensitive`, AES-256-GCM) existaient déjà dans le fichier mais n'étaient pas utilisés pour ces données.

## 3. Exploitation (preuve)

Le numéro se décode sans clé :

```
echo -n 'RlItREVNTy1CUlVOTy04NzQy' | base64 -d  →  FR-DEMO-BRUNO-8742
```

Connecté en tant que Bruno, ce numéro soumis à l'endpoint de preuve `POST /api/challenges/a04/claim` renvoie le flag `FLAG{a04_0ae49374a1fd698761e11774}` (le `tokenDigest` du passeport correspond au digest attendu).

> 📸 Capture 1 : flag dans la réponse de `/api/challenges/a04/claim` (DevTools → Réseau → Réponse). Aucun jeton d'authentification visible.

## 4. Correction

### 4.1 Basculer les écritures en AES-256-GCM

- `compose.yaml` et `.env.example` : `PASSPORT_PROTECTION_MODE=aes-gcm`.
- `apps/api/src/config.ts` : valeur par défaut → `aes-gcm`.

`protectPassport` emprunte alors la branche `encryptSensitive`, qui produit `ciphertext`, `iv` (nonce aléatoire de 12 octets) et `tag` d'authentification.

### 4.2 Migrer les enregistrements hérités

Changer le mode ne protège que les écritures **futures** ; la ligne de Bruno restait en base64 (« changing only the runtime mode does not migrate seeded records »). Un script applicatif `apps/api/src/migrate-passports.ts` convertit les lignes existantes :

```ts
// SELECT des lignes où passport_iv = 'legacy-base64'
const plaintext = Buffer.from(row.passport_ciphertext, 'base64').toString('utf8');
const { ciphertext, iv, tag } = encryptSensitive(plaintext, keyHex);
// UPDATE passport_ciphertext / passport_iv / passport_tag
```

Il est idempotent (les lignes déjà chiffrées sont ignorées) et exécuté une fois :

```
docker compose exec app node --import tsx apps/api/src/migrate-passports.ts
→ Migrated 1 passport(s) to AES-256-GCM.
```

Vérification en base, avant / après :

| | `passport_iv` | `passport_ciphertext` (début) |
|---|---|---|
| Avant | `legacy-base64` | `RlItREVNTy1CUlVOTy04` (base64 lisible) |
| Après | `Lr7oOSH0SJflyZDD` (nonce) | `XXJntszME2WD6w11uMd6` (chiffré) |

### 4.3 Supprimer l'endpoint de preuve

La route `POST /api/challenges/a04/claim` a été retirée de `profile.ts` (ainsi que l'import `tokenDigest` devenu inutile). Rejouer la requête renvoie désormais `404 {"error":"Ressource introuvable"}` : l'ancienne preuve ne peut plus restituer de flag.

> 📸 Capture 2 : même requête `/api/challenges/a04/claim` après correction → 404, sans flag.

### 4.4 Gestion de la clé

La clé `APP_ENCRYPTION_KEY` (32 octets hexadécimaux) est fournie par l'environnement et consommée par `encryptSensitive`, qui refuse toute clé de longueur incorrecte. `revealPassport` reste capable de lire les deux représentations le temps de la bascule, mais `protectPassport` n'écrit plus qu'en AES-GCM.

## 5. Tests — `tests/api/a04-cryptographic-failures.test.ts`

L'ancien test, qui s'appuyait sur l'endpoint de preuve supprimé, a été remplacé.

| Test | Type | Ce qu'il prouve |
|---|---|---|
| stored passport is authenticated-encrypted, not just encoded | Sécurité | La valeur stockée ne contient pas le passeport (ni en clair ni en base64) et porte un tag d'authentification ; plus de marqueur `legacy-base64`. |
| tampered ciphertext is rejected | Sécurité | Altérer le tag fait échouer `revealPassport` (propriété d'authentification d'AES-GCM). |
| an authorised profile round-trip preserves the passport | Métier | Chiffrer puis déchiffrer restitue le passeport d'origine : la lecture autorisée fonctionne toujours. |

Résultat : `docker compose run --rm --no-deps app npm test` → tous les tests passent.

> 📸 Capture 3 : suite de tests complète au vert.

## 6. Vérification des conditions d'atterrissage

| Condition de l'énoncé | Statut |
|---|---|
| Les enregistrements hérités utilisent du chiffrement authentifié | ✅ migration exécutée, IV/tag réels en base |
| Les écritures futures utilisent du chiffrement authentifié | ✅ mode `aes-gcm` par défaut |
| Donnée non récupérable sans la clé | ✅ ciphertext AES-256-GCM |
| Altération rejetée | ✅ tag GCM vérifié, testé |
| Lecture/mise à jour autorisée toujours fonctionnelle | ✅ profil de Bruno affiche toujours `FR-DEMO-BRUNO-8742` |
| Endpoint de preuve supprimé | ✅ 404 |
| 1 test sécurité + 1 test métier | ✅ 2 tests sécurité + 1 test métier |

## 7. Remarques

- **Principe retenu :** « illisible au premier coup d'œil » n'est pas « chiffré ». Le base64 est un encodage réversible sans secret ; seule une clé rend la donnée confidentielle. AES-256-GCM ajoute l'authentification, qui fait échouer toute altération.
- **Observé hors périmètre (A07) :** le cookie de session `auth_token` est un JWT dont le payload (`{"authenticated":true,"exp":...}`) ne contient aucune identité. Cela relève du challenge d'authentification, non traité ici.