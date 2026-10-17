# A09 — Security Logging and Monitoring Failures (The Silent Suitcase)

## Vulnerability

L'annulation d'une réservation (`POST /api/bookings/:id/cancel`) modifiait l'état métier sans écrire aucun événement de sécurité. Toutes les autres actions sensibles — création de réservation, tickets support — appellent `recordAudit(...)`, mais le handler d'annulation ne le faisait jamais. Résultat : une réservation disparaissait du tableau de départ sans que le support puisse reconstituer **qui** l'avait annulée, **quelle** réservation avait changé, **quand** et **avec quel résultat**. La notification de succès affichée au voyageur n'est pas un historique d'audit.

## Exploitation

Depuis le compte de démonstration actif (Alice), l'annulation d'une réservation possédée via l'interface (bouton « Annuler ») ou l'API renvoyait `{ booking: { ..., status: 'cancelled' }, flag: 'FLAG{a09_420572fdf54470e24351ef29}' }`. En comparant l'état métier au feed d'audit réservé au support (`GET /api/audit`), on constatait que la réservation était bien passée à `cancelled` mais qu'**aucun** événement lié à cette réservation et à l'action d'annulation n'y figurait — contrairement au `booking.created` présent lors de sa création. L'action sensible ne laissait aucune trace durable. Capture : `flag-cancel.png`.

## Root Cause

```ts
// apps/api/src/routes/bookings.ts — /api/bookings/:id/cancel (avant)
const result = await pool.query(
  `UPDATE bookings SET status='cancelled'
   WHERE id=$1 AND user_id=$2 AND status<>'cancelled'
   RETURNING id,reference,status`,
  [id, request.authUser!.id]
);
if (!result.rowCount) return reply.code(404).send({ error: 'Réservation annulable introuvable' });
return { booking: result.rows[0], flag: flags.get('A09') };
```
Aucun appel à `recordAudit` : ni pour le succès, ni pour un refus. L'écriture n'était pas transactionnelle non plus, donc même en ajoutant un audit naïf, une annulation aurait pu être commise sans sa trace.

## Remediation

`bookings.ts` : le handler d'annulation s'exécute désormais dans une transaction, et chaque issue laisse une trace durable via le writer d'audit existant (`recordAudit`), partagé avec le changement métier dans le même client :
```ts
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const result = await client.query(
    `UPDATE bookings SET status='cancelled'
     WHERE id=$1 AND user_id=$2 AND status<>'cancelled'
     RETURNING id,reference,status`,
    [id, request.authUser!.id]
  );
  if (!result.rowCount) {
    await recordAudit(client, request.authUser, 'booking.cancel_denied', 'booking', id, {
      result: 'denied', reason: 'not-owned-or-already-cancelled'
    });
    await client.query('COMMIT');
    return reply.code(404).send({ error: 'Réservation annulable introuvable' });
  }
  await recordAudit(client, request.authUser, 'booking.cancelled', 'booking', id, {
    reference: result.rows[0].reference, result: 'success'
  });
  await client.query('COMMIT');
  return { booking: result.rows[0] };
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
}
```
L'`UPDATE` métier et l'`INSERT` d'audit sont dans la même transaction : un succès commit les deux ensemble, et si l'écriture d'audit échoue, l'annulation est annulée (`ROLLBACK`). Les succès comme les refus suspects produisent un événement structuré portant l'acteur (`user_id`), l'action, la cible (`entity_id`), le résultat (`metadata.result`) et l'horodatage (`created_at`). Les métadonnées ne contiennent aucun secret (seulement `reference`, `result`, `reason`). La réponse pédagogique exposant le drapeau a été retirée : le handler renvoie uniquement `{ booking }`.

## Verification

Test métier positif : une réservation possédée est annulée (`200`, `status: 'cancelled'`, sans drapeau). Tests de régression : une annulation réussie écrit un événement `booking.cancelled` **dans la même transaction** que la mutation (BEGIN … COMMIT) ; une tentative sur une réservation non annulable est refusée (`404`) **sans mutation métier** tout en traçant un `booking.cancel_denied` ; et lorsqu'une écriture d'audit échoue, la transaction est annulée (`ROLLBACK`, pas de `COMMIT`), garantissant l'atomicité. En manuel, une nouvelle réservation annulable est annulée sans drapeau après remédiation, avec son événement d'audit visible côté support (voir `cancel-after-fix.png`). La suite complète de tests réussit — voir `passing-tests.png`.