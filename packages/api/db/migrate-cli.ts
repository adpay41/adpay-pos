import { loadDatabaseUrl } from '../config';
import { createPgDb } from './db';
import { migrate } from './migrate';

const db = createPgDb(loadDatabaseUrl());
try {
  const ran = await migrate(db, (m) => console.log(`[migrate] ${m}`));
  console.log(ran.length ? `[migrate] ${ran.length} migration(s) applied` : '[migrate] database is up to date');
} finally {
  await db.close();
}
