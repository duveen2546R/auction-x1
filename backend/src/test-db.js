import pool, {
  formatDbError,
  getDatabaseSummary,
  verifyDatabaseConnection,
} from "./db.js";

async function main() {
  const db = getDatabaseSummary();

  try {
    await verifyDatabaseConnection();
    console.log(`Supabase Postgres connected at ${db.host}:${db.port}/${db.database}`);
    process.exitCode = 0;
  } catch (error) {
    console.error(
      `Supabase Postgres connection failed at ${db.host}:${db.port}/${db.database}: ${formatDbError(error)}`
    );
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
