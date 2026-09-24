import { Client } from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DEMO_DATABASE_URL) throw new Error('Set DEMO_DATABASE_URL to your disposable local database');
const url = new URL(process.env.DEMO_DATABASE_URL);
if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || process.env.NODE_ENV === 'production') {
  throw new Error('DEMO seed is restricted to local development');
}
const client = new Client({ connectionString: url.toString() });
try {
  await client.connect();
  await client.query('begin');
  await client.query(await readFile('supabase/seeds/demo.sql', 'utf8'));
  await client.query('commit');
  console.log('Local DEMO loaded. All commercial values and timezone are unconfirmed.');
} catch {
  await client.query('rollback').catch(() => {});
  throw new Error('DEMO seed failed; transaction rolled back. Verify local database and migrations.');
} finally { await client.end(); }
