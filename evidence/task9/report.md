# A10 — Exceptional Conditions (The Emergency Exit Is Open)

## Vulnerability

La confirmation finale d'une réservation (`POST /api/bookings/:id/confirm`) impose une condition obligatoire : la réservation doit être `pending` **et** son paiement `approved`. Mais ce contrôle était enveloppé dans un `try/catch` dont la branche d'erreur faisait `checksPassed = true`. Autrement dit, si le contrôle de disponibilité devenait **indisponible** (exception), l'application traitait le silence comme une approbation et ouvrait la « sortie de secours » directement vers `confirmed`. Un paiement manquant et un contrôle indisponible sont deux situations différentes, mais **aucune** ne doit autoriser la confirmation : ici, l'indisponibilité le faisait (« fail-open »).

## Exploitation

Depuis le compte de démonstration actif (Alice), une **nouvelle réservation réellement impayée** (`status = pending`, `payment_status = null`) a été créée. La route n'ayant pas de bouton dédié dans l'interface, l'appel a été rejoué depuis les DevTools du navigateur, en réutilisant la session authentifiée et le champ de simulation sûr fourni par le lab :

```js
fetch('/api/bookings/<id>/confirm', {
  method: 'POST',
  headers: { 'content-type': 'application/json',
             'authorization': 'Bearer ' + localStorage.getItem('holbie-token') },
  body: JSON.stringify({ simulateCheckFailure: true })
}).then(r => r.json()).then(console.log)
```

Réponse obtenue : `{ status: 'confirmed', flag: 'FLAG{a10_59e7203d61ff3e2ce709cab3}' }`. La réservation **non payée** est passée à `confirmed` uniquement parce que le contrôle obligatoire avait « échoué ». Capture : `vulnerability.png`.

## Root Cause

```ts
// apps/api/src/routes/bookings.ts — /api/bookings/:id/confirm (avant)
let checksPassed = false;
try {
  if (simulateFailure) throw new Error('Local readiness checker unavailable');
  checksPassed = result.rows[0].status === 'pending' && result.rows[0].payment_status === 'approved';
} catch {
  checksPassed = true;            // ← incertitude transformée en approbation (fail-open)
}
if (!checksPassed) {
  return reply.code(409).send({ error: 'La réservation ne peut pas encore être confirmée' });
}
await pool.query(`UPDATE bookings SET status='confirmed' WHERE id=$1`, [id]);
return { status: 'confirmed', ...(simulateFailure ? { flag: flags.get('A10') } : {}) };
```

Le `catch` positionnait `checksPassed = true` : une erreur du contrôle (service indisponible, timeout, exception) devenait un feu vert. Le défaut de sécurité n'est pas l'exception elle-même, mais la **politique** appliquée à l'incertitude : approuver par défaut au lieu de refuser.

## Remediation

`bookings.ts` : l'incertitude reste un refus (« fail-closed »). Lorsque le contrôle obligatoire est indisponible, le handler ne confirme pas, ne modifie pas l'état de la réservation, et renvoie une erreur **retryable** et **non sensible** :

```ts
let checksPassed: boolean;
try {
  if (simulateFailure) throw new Error('Local readiness checker unavailable');
  checksPassed = result.rows[0].status === 'pending' && result.rows[0].payment_status === 'approved';
} catch {
  // Contrôle indisponible : état métier inchangé, erreur retryable sans détail interne.
  request.log.warn({ bookingId: id }, 'confirmation readiness check unavailable');
  return reply
    .code(503)
    .header('retry-after', '5')
    .send({ error: 'Vérification indisponible, réessayez plus tard' });
}

if (!checksPassed) {
  return reply.code(409).send({ error: 'La réservation ne peut pas encore être confirmée' });
}

await pool.query(`UPDATE bookings SET status='confirmed' WHERE id=$1`, [id]);
return { status: 'confirmed' };
```

Points clés : un contrôle **réussi** autorise la confirmation ; un contrôle **indisponible** renvoie `503` (retryable) sans changer l'état ; un contrôle **exécuté mais non satisfait** (ex. paiement manquant) renvoie `409`, état inchangé. Le message d'erreur ne révèle aucun interne (ni « readiness checker », ni message d'exception, ni pile d'appels) ; le détail n'est écrit que dans le journal serveur. La réponse pédagogique exposant le drapeau a été retirée : le handler renvoie uniquement `{ status: 'confirmed' }`.

## Verification

Tests (`tests/api/a10-exceptional-conditions.test.ts`) exécutés dans le conteneur :

- **Régression sécurité** (ancienne caractérisation inversée) : un contrôle obligatoire indisponible (`simulateCheckFailure: true`) renvoie `503`, sans drapeau, sans fuite d'interne, et **aucune** confirmation n'est écrite (état métier préservé).
- **Parcours positif** (nouveau) : une réservation `pending` avec paiement `approved` est confirmée (`200`, `{ status: 'confirmed' }`, sans drapeau).
- **Rejet métier conservé** : une réservation `pending` sans paiement est refusée (`409`), sans mutation.

La suite complète réussit — voir `passing_test.png`. En manuel, après remédiation, la même attaque sur une nouvelle réservation impayée est correctement rejetée (`503 { error: 'Vérification indisponible, réessayez plus tard' }`), sans drapeau et sans passage à `confirmed` — voir `remediation.png`.
