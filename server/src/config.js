import dotenv from 'dotenv';
import fs from 'fs';

if (fs.existsSync('.env.local')) {
  dotenv.config({ path: '.env.local', override: true });
}
dotenv.config({ override: true });

const required = [
  'DATABASE_URL',
  'JWT_SECRET',
  'DOMAIN',
  'OPENAI_API_KEY',
  'OPENAI_MODEL'
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.warn(`Missing env vars: ${missing.join(', ')}`);
}

export const config = {
  port: Number(process.env.PORT || 8000),
  databaseUrl: process.env.DATABASE_URL,
  customerDbAdminUrl: process.env.CUSTOMER_DB_ADMIN_URL || '',
  customerDbHost: process.env.CUSTOMER_DB_HOST || 'localhost',
  customerDbPort: Number(process.env.CUSTOMER_DB_PORT || 5432),
  customerDbUser: process.env.CUSTOMER_DB_USER || 'app_user',
  customerDbPassword: process.env.CUSTOMER_DB_PASSWORD || '',
  customerDbSslMode: process.env.CUSTOMER_DB_SSLMODE || 'disable',
  customerDbSslRootCert: process.env.CUSTOMER_DB_SSLROOTCERT || '',
  jwtSecret: process.env.JWT_SECRET,
  domain: process.env.DOMAIN || 'localhost:8000',
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  runMigrations: process.env.RUN_MIGRATIONS === 'true',
  allowPasswordBypass: process.env.ALLOW_PASSWORD_BYPASS === 'true',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  corsOriginExtra: process.env.CORS_ORIGIN_EXTRA || '',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 50),
  desktopDownloadPath: process.env.DESKTOP_DOWNLOAD_PATH || '',
  desktopDownloadDir: process.env.DESKTOP_DOWNLOAD_DIR || '',
  defaultUserPlan: String(process.env.DEFAULT_USER_PLAN || 'starter').toLowerCase()
};
