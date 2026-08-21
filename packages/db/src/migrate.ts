#!/usr/bin/env node
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sql as connection } from './client.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import * as dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root
dotenv.config({ path: resolve(__dirname, '../../../.env') });

async function main() {
  console.log('Running migrations...');

  await migrate(db, { migrationsFolder: resolve(__dirname, '../migrations') });

  console.log('Migrations complete!');
  await connection.end();
}

main().catch((err) => {
  console.error('Migration failed!', err);
  process.exit(1);
});
