import "./env.js";
import { Client, Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL?.trim();

function getDatabaseConfig() {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required. Set it to your Supabase Postgres connection string.");
  }

  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection string for Supabase.");
  }

  const isLocal =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  const sslDisabled =
    process.env.DB_SSL === "false" ||
    url.searchParams.get("sslmode") === "disable";

  return {
    connectionString: databaseUrl,
    host: url.hostname,
    port: Number(url.port) || 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    ssl: !isLocal && !sslDisabled ? { rejectUnauthorized: false } : false,
  };
}

const config = getDatabaseConfig();

function convertPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

const pgPool = new Pool({
  connectionString: config.connectionString,
  ssl: config.ssl,
  max: 10,
});

const pool = {
  async query(sql, params = []) {
    const result = await pgPool.query(convertPlaceholders(sql), params);
    const statement = sql.trim().split(/\s+/, 1)[0]?.toUpperCase() || "";

    if (statement === "SELECT" || statement === "WITH") {
      return [result.rows];
    }

    return [
      {
        rowCount: result.rowCount,
        rows: result.rows,
        insertId: result.rows[0]?.id ?? null,
      },
    ];
  },
  async connect() {
    return pgPool.connect();
  },
  async end() {
    return pgPool.end();
  },
};

export function getDatabaseSummary() {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
  };
}

export function formatDbError(error) {
  const details = [
    error?.code,
    error?.errno != null ? `errno ${error.errno}` : null,
    error?.detail,
    error?.message,
  ].filter(Boolean);

  return details.length ? details.join(" | ") : "Unknown database error";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function verifyDatabaseConnection(retries = 5, retryDelayMs = 3000) {
  let remainingRetries = retries;
  let lastError = null;

  while (remainingRetries > 0) {
    let client;
    try {
      client = new Client({
        connectionString: config.connectionString,
        ssl: config.ssl,
      });
      await client.connect();
      await client.query("SELECT 1");
      return;
    } catch (error) {
      lastError = error;
      remainingRetries -= 1;

      if (remainingRetries > 0) {
        console.log(`Retrying DB... ${formatDbError(error)}`);
        await sleep(retryDelayMs);
      }
    } finally {
      if (client) {
        await client.end().catch(() => {});
      }
    }
  }

  throw lastError || new Error("DB connection failed");
}

export default pool;
