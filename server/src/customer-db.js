import pg from 'pg';
import { config } from './config.js';
import { query } from './db.js';

const { Pool } = pg;
const poolCache = new Map();
const adminPool = config.customerDbAdminUrl
  ? new Pool({ connectionString: config.customerDbAdminUrl })
  : null;

function poolForConnectionString(connectionString) {
  let pool = poolCache.get(connectionString);
  if (!pool) {
    pool = new Pool({ connectionString });
    poolCache.set(connectionString, pool);
  }
  return pool;
}

export function dbNameFor(shortId, environment) {
  const safe = `${shortId}-${environment}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const rawPrefix = String(process.env.PROJECT_DATABASE_PREFIX || 'vibes')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '') || 'vibes';
  const maxPrefixLength = Math.max(1, 63 - safe.length - 1);
  const prefix = rawPrefix.slice(0, maxPrefixLength).replace(/_+$/g, '') || 'vibes';
  return `${prefix}_${safe}`;
}

export function dbUrlFor(dbName) {
  if (config.customerDbSslMode !== 'disable' && !config.customerDbSslRootCert) {
    throw new Error('CUSTOMER_DB_SSLROOTCERT is required when CUSTOMER_DB_SSLMODE is not disable');
  }
  const auth = `${encodeURIComponent(config.customerDbUser)}:${encodeURIComponent(config.customerDbPassword)}`;
  const params = new URLSearchParams();
  params.set('sslmode', config.customerDbSslMode);
  if (config.customerDbSslRootCert) params.set('sslrootcert', config.customerDbSslRootCert);
  return `postgresql://${auth}@${config.customerDbHost}:${config.customerDbPort}/${dbName}?${params.toString()}`;
}

export function dbUrlMatchesConfig(dbUrl) {
  if (!dbUrl) return false;
  try {
    const url = new URL(dbUrl);
    if (config.customerDbHost && url.hostname !== config.customerDbHost) return false;
    if (config.customerDbPort && Number(url.port || 5432) !== Number(config.customerDbPort)) return false;
    if (config.customerDbUser && decodeURIComponent(url.username) !== config.customerDbUser) return false;
    if (config.customerDbPassword && decodeURIComponent(url.password) !== config.customerDbPassword) return false;
    return true;
  } catch {
    return false;
  }
}

async function ensureDatabaseExists(dbName) {
  if (!adminPool) {
    throw new Error('CUSTOMER_DB_ADMIN_URL is required to provision customer databases');
  }
  const exists = await adminPool.query('select 1 from pg_database where datname = $1', [dbName]);
  if (exists.rowCount > 0) return;
  await adminPool.query(`create database ${dbName}`);
}

export async function resolveEnvironmentDatabase(projectId, environment) {
  const result = await query(
    `select p.short_id,
            e.db_name,
            e.db_url
       from projects p
       left join environments e
         on e.project_id = p.id
        and e.name = $2
      where p.id = $1`,
    [projectId, environment]
  );
  const row = result.rows[0];
  if (!row) {
    const err = new Error('project_not_found');
    err.code = 'project_not_found';
    err.status = 404;
    throw err;
  }
  const dbName = row.db_name || dbNameFor(row.short_id, environment);
  let dbUrl = row.db_url || '';
  const urlIsCurrent = dbUrlMatchesConfig(dbUrl);
  if (!dbUrl || (config.customerDbHost && !urlIsCurrent)) {
    await ensureDatabaseExists(dbName);
    dbUrl = dbUrlFor(dbName);
    await query(
      `insert into environments (project_id, name, db_name, db_url)
       values ($1, $2, $3, $4)
       on conflict (project_id, name)
       do update set db_name = excluded.db_name, db_url = excluded.db_url`,
      [projectId, environment, dbName, dbUrl]
    );
  }
  return { dbName, dbUrl };
}

export async function withCustomerDb(projectId, environment, fn) {
  const { dbName, dbUrl } = await resolveEnvironmentDatabase(projectId, environment);
  const pool = poolForConnectionString(dbUrl);
  const client = await pool.connect();
  try {
    return await fn(client, { dbName, dbUrl });
  } finally {
    client.release();
  }
}
