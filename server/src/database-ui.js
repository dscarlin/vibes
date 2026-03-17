import crypto from 'crypto';
import { query as controlQuery } from './db.js';
import { withCustomerDb } from './customer-db.js';

const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];
const METADATA_TIMEOUT_MS = 4000;
const BROWSE_TIMEOUT_MS = 8000;
const QUERY_TIMEOUT_MS = 12000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const MAX_SQL_ROWS = 200;
const MAX_HISTORY_ROWS = 25;

function createDatabaseError(code, message, status = 400, retryable = false, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.retryable = retryable;
  err.details = details;
  return err;
}

function quoteIdentifier(value) {
  if (typeof value !== 'string' || !value) {
    throw createDatabaseError('invalid_identifier', 'Missing database identifier.', 400, false);
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function normalizePageSize(value) {
  const num = Number(value || DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(num)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(num)));
}

function normalizePage(value) {
  const num = Number(value || 1);
  if (!Number.isFinite(num)) return 1;
  return Math.max(1, Math.floor(num));
}

function cleanSql(sql) {
  return String(sql || '').trim();
}

function stripTrailingSemicolons(sql) {
  return sql.replace(/;+\s*$/g, '').trim();
}

function classifyReadOnlySql(sql) {
  const trimmed = stripTrailingSemicolons(cleanSql(sql));
  if (!trimmed) {
    throw createDatabaseError('sql_required', 'SQL is required.', 400, false);
  }
  if (trimmed.includes(';')) {
    throw createDatabaseError('sql_multi_statement_not_allowed', 'Only one statement is allowed.', 400, false);
  }
  const normalized = trimmed
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .trim()
    .toLowerCase();
  if (!/^(select|with|explain)\b/.test(normalized)) {
    throw createDatabaseError('sql_read_only_required', 'Only read-only SELECT, WITH, and EXPLAIN statements are allowed.', 400, false);
  }
  const blocked = [
    'insert',
    'update',
    'delete',
    'merge',
    'alter',
    'drop',
    'truncate',
    'create',
    'grant',
    'revoke',
    'copy',
    'listen',
    'notify',
    'vacuum',
    'call',
    'do',
    'comment',
    'refresh',
    'reindex',
    'cluster',
    'discard',
    'set',
    'reset',
    'show',
    'begin',
    'commit',
    'rollback',
    'savepoint',
    'release',
    'lock'
  ];
  for (const keyword of blocked) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(normalized)) {
      throw createDatabaseError('sql_statement_blocked', `Blocked keyword detected: ${keyword}.`, 400, false);
    }
  }
  return {
    sql: trimmed,
    mode: normalized.startsWith('explain') ? 'explain' : 'select'
  };
}

function queryPreview(sql) {
  return cleanSql(sql).replace(/\s+/g, ' ').slice(0, 160);
}

function queryHash(sql) {
  return crypto.createHash('sha256').update(cleanSql(sql)).digest('hex');
}

function requestIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || '';
}

export async function writeDatabaseAudit(req, {
  projectId,
  environment,
  action,
  schemaName = null,
  objectName = null,
  queryText = '',
  success = true,
  durationMs = 0,
  rowCount = null,
  errorCode = null
} = {}) {
  const preview = queryText ? queryPreview(queryText) : null;
  const hash = queryText ? queryHash(queryText) : null;
  await controlQuery(
    `insert into database_console_audit (
       user_id,
       project_id,
       environment,
       action,
       schema_name,
       object_name,
       query_hash,
       query_preview,
       success,
       duration_ms,
       row_count,
       error_code,
       ip,
       user_agent
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
     )`,
    [
      req.user.userId,
      projectId,
      environment,
      action,
      schemaName,
      objectName,
      hash,
      preview,
      success,
      Number(durationMs || 0),
      rowCount == null ? null : Number(rowCount),
      errorCode,
      requestIp(req),
      String(req.headers['user-agent'] || '')
    ]
  );
}

async function runReadOnly(client, timeoutMs, work) {
  await client.query('begin read only');
  try {
    await client.query(`set local statement_timeout = ${Number(timeoutMs)}`);
    const result = await work();
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
}

async function loadColumns(client, schemaName, objectName) {
  const result = await client.query(
    `select column_name,
            data_type,
            udt_name,
            is_nullable,
            column_default,
            ordinal_position
       from information_schema.columns
      where table_schema = $1
        and table_name = $2
      order by ordinal_position asc`,
    [schemaName, objectName]
  );
  return result.rows.map((row) => ({
    name: row.column_name,
    dataType: row.data_type,
    udtName: row.udt_name,
    nullable: row.is_nullable === 'YES',
    defaultValue: row.column_default,
    ordinalPosition: row.ordinal_position
  }));
}

async function loadObjectDetails(client, schemaName, objectName) {
  const objectResult = await client.query(
    `select c.oid,
            c.relname as object_name,
            case
              when c.relkind in ('r', 'p') then 'table'
              when c.relkind = 'm' then 'materialized_view'
              else 'view'
            end as object_type,
            pg_total_relation_size(c.oid)::bigint as total_bytes,
            coalesce(s.n_live_tup::bigint, c.reltuples::bigint, 0) as estimated_rows
       from pg_class c
       join pg_namespace n
         on n.oid = c.relnamespace
       left join pg_stat_user_tables s
         on s.relid = c.oid
      where n.nspname = $1
        and c.relname = $2
        and c.relkind in ('r', 'p', 'v', 'm')`,
    [schemaName, objectName]
  );
  const object = objectResult.rows[0];
  if (!object) {
    throw createDatabaseError('database_object_not_found', 'Database object not found.', 404, false);
  }
  const [columns, primaryKeys, foreignKeys, indexes] = await Promise.all([
    loadColumns(client, schemaName, objectName),
    client.query(
      `select kcu.column_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on tc.constraint_name = kcu.constraint_name
          and tc.table_schema = kcu.table_schema
        where tc.table_schema = $1
          and tc.table_name = $2
          and tc.constraint_type = 'PRIMARY KEY'
        order by kcu.ordinal_position asc`,
      [schemaName, objectName]
    ),
    client.query(
      `select kcu.column_name,
              ccu.table_schema as foreign_table_schema,
              ccu.table_name as foreign_table_name,
              ccu.column_name as foreign_column_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on tc.constraint_name = kcu.constraint_name
          and tc.table_schema = kcu.table_schema
         join information_schema.constraint_column_usage ccu
           on ccu.constraint_name = tc.constraint_name
          and ccu.table_schema = tc.table_schema
        where tc.table_schema = $1
          and tc.table_name = $2
          and tc.constraint_type = 'FOREIGN KEY'
        order by kcu.column_name asc`,
      [schemaName, objectName]
    ),
    client.query(
      `select indexname,
              indexdef
         from pg_indexes
        where schemaname = $1
          and tablename = $2
        order by indexname asc`,
      [schemaName, objectName]
    )
  ]);
  return {
    schema: schemaName,
    name: object.object_name,
    type: object.object_type,
    estimatedRows: Number(object.estimated_rows || 0),
    totalBytes: Number(object.total_bytes || 0),
    columns,
    primaryKey: primaryKeys.rows.map((row) => row.column_name),
    foreignKeys: foreignKeys.rows.map((row) => ({
      column: row.column_name,
      referencesSchema: row.foreign_table_schema,
      referencesTable: row.foreign_table_name,
      referencesColumn: row.foreign_column_name
    })),
    indexes: indexes.rows.map((row) => ({
      name: row.indexname,
      definition: row.indexdef
    }))
  };
}

export async function getDatabaseCatalog(projectId, environment) {
  return withCustomerDb(projectId, environment, async (client) => {
    return runReadOnly(client, METADATA_TIMEOUT_MS, async () => {
      const result = await client.query(
        `select n.nspname as schema_name,
                c.relname as object_name,
                case
                  when c.relkind in ('r', 'p') then 'table'
                  when c.relkind = 'm' then 'materialized_view'
                  else 'view'
                end as object_type,
                coalesce(s.n_live_tup::bigint, c.reltuples::bigint, 0) as estimated_rows,
                pg_total_relation_size(c.oid)::bigint as total_bytes
           from pg_class c
           join pg_namespace n
             on n.oid = c.relnamespace
           left join pg_stat_user_tables s
             on s.relid = c.oid
          where c.relkind in ('r', 'p', 'v', 'm')
            and n.nspname <> all($1)
          order by n.nspname asc, c.relname asc`,
        [SYSTEM_SCHEMAS]
      );
      const bySchema = new Map();
      for (const row of result.rows) {
        if (!bySchema.has(row.schema_name)) {
          bySchema.set(row.schema_name, []);
        }
        bySchema.get(row.schema_name).push({
          name: row.object_name,
          type: row.object_type,
          estimatedRows: Number(row.estimated_rows || 0),
          totalBytes: Number(row.total_bytes || 0)
        });
      }
      const schemas = Array.from(bySchema.entries()).map(([name, objects]) => ({
        name,
        objects
      }));
      return {
        environment,
        mode: 'read-only',
        schemas
      };
    });
  });
}

export async function getDatabaseObjectDetails(projectId, environment, schemaName, objectName) {
  return withCustomerDb(projectId, environment, async (client) => {
    return runReadOnly(client, METADATA_TIMEOUT_MS, async () => loadObjectDetails(client, schemaName, objectName));
  });
}

export async function browseDatabaseRows(projectId, environment, schemaName, objectName, options = {}) {
  return withCustomerDb(projectId, environment, async (client) => {
    return runReadOnly(client, BROWSE_TIMEOUT_MS, async () => {
      const object = await loadObjectDetails(client, schemaName, objectName);
      if (!['table', 'view', 'materialized_view'].includes(object.type)) {
        throw createDatabaseError('database_object_not_browsable', 'This object cannot be browsed.', 400, false);
      }
      const pageSize = normalizePageSize(options.pageSize);
      const page = normalizePage(options.page);
      const offset = (page - 1) * pageSize;
      const allowedColumns = new Set(object.columns.map((column) => column.name));
      const sortColumn = allowedColumns.has(options.sortColumn) ? options.sortColumn : (object.primaryKey[0] || object.columns[0]?.name || '');
      const sortDirection = String(options.sortDirection || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
      const filterColumn = allowedColumns.has(options.filterColumn) ? options.filterColumn : '';
      const filterValue = String(options.filterValue || '').trim();
      let whereSql = '';
      const params = [];
      if (filterColumn && filterValue) {
        params.push(`%${filterValue}%`);
        whereSql = `where cast(${quoteIdentifier(filterColumn)} as text) ilike $${params.length}`;
      }
      const limitParam = `$${params.push(pageSize + 1)}`;
      const offsetParam = `$${params.push(offset)}`;
      const orderSql = sortColumn ? `order by ${quoteIdentifier(sortColumn)} ${sortDirection}` : '';
      const sql = `select * from ${quoteIdentifier(schemaName)}.${quoteIdentifier(objectName)} ${whereSql} ${orderSql} limit ${limitParam} offset ${offsetParam}`;
      const result = await client.query(sql, params);
      const rows = result.rows.slice(0, pageSize);
      return {
        schema: schemaName,
        object: objectName,
        page,
        pageSize,
        sortColumn,
        sortDirection,
        filterColumn,
        filterValue,
        columns: object.columns.map((column) => ({
          name: column.name,
          dataType: column.dataType
        })),
        rows,
        hasMore: result.rows.length > pageSize,
        estimatedRows: object.estimatedRows
      };
    });
  });
}

export async function executeDatabaseQuery(projectId, environment, sql) {
  const statement = classifyReadOnlySql(sql);
  return withCustomerDb(projectId, environment, async (client) => {
    return runReadOnly(client, QUERY_TIMEOUT_MS, async () => {
      const startedAt = Date.now();
      const rawSql =
        statement.mode === 'select'
          ? `select * from (${statement.sql}) as vibes_read_only_query limit ${MAX_SQL_ROWS + 1}`
          : statement.sql;
      const result = await client.query(rawSql);
      const durationMs = Date.now() - startedAt;
      const rows = result.rows.slice(0, MAX_SQL_ROWS);
      return {
        mode: 'read-only',
        rowCount: rows.length,
        durationMs,
        truncated: result.rows.length > MAX_SQL_ROWS,
        columns: result.fields.map((field) => ({ name: field.name })),
        rows
      };
    });
  });
}

export async function loadDatabaseHistory(projectId, environment, limit = MAX_HISTORY_ROWS) {
  const safeLimit = Math.max(1, Math.min(MAX_HISTORY_ROWS, Number(limit || MAX_HISTORY_ROWS)));
  const result = await controlQuery(
    `select action,
            schema_name,
            object_name,
            query_preview,
            success,
            duration_ms,
            row_count,
            error_code,
            created_at
       from database_console_audit
      where project_id = $1
        and environment = $2
      order by created_at desc
      limit $3`,
    [projectId, environment, safeLimit]
  );
  return result.rows;
}

export function databaseErrorPayload(err) {
  return {
    code: err.code || 'database_request_failed',
    message: err.message || 'Database request failed.',
    retryable: Boolean(err.retryable),
    details: err.details || {}
  };
}
