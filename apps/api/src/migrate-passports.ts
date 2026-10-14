import { Pool } from 'pg';
import { encryptSensitive } from './security.js';

async function migrate() {
  const keyHex = process.env.APP_ENCRYPTION_KEY;
  if (!keyHex) throw new Error('APP_ENCRYPTION_KEY manquant');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query(
      `SELECT user_id, passport_ciphertext
       FROM traveler_profiles
       WHERE passport_iv = 'legacy-base64' AND passport_ciphertext IS NOT NULL`
    );

    for (const row of rows) {
      const plaintext = Buffer.from(row.passport_ciphertext, 'base64').toString('utf8');
      const { ciphertext, iv, tag } = encryptSensitive(plaintext, keyHex);
      await pool.query(
        `UPDATE traveler_profiles
         SET passport_ciphertext=$2, passport_iv=$3, passport_tag=$4, updated_at=now()
         WHERE user_id=$1`,
        [row.user_id, ciphertext, iv, tag]
      );
    }
    console.log(`Migrated ${rows.length} passport(s) to AES-256-GCM.`);
  } finally {
    await pool.end();
  }
}

migrate().catch(err => { console.error(err); process.exit(1); });
