import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'turso',
  dbCredentials: {
    url: `file:${process.env.DATABASE_PATH || './narratorr.db'}`,
  },
});
