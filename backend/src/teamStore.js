import pool, { formatDbError } from "./db.js";
import { fallbackTeams } from "./data/teams.js";

export async function loadTeams() {
  try {
    const [rows] = await pool.query("SELECT id, name, budget FROM teams ORDER BY name ASC");
    if (rows.length) return rows;
  } catch (err) {
    console.warn("DB unavailable for teams, using fallback:", formatDbError(err));
  }
  return fallbackTeams;
}
