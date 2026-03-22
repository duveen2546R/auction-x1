import pool, { formatDbError } from "./db.js";
import { fallbackPlayers } from "./data/players.js";

export async function loadPlayers() {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, role, rating, batting_rating, bowling_rating, base_price, country FROM cricketers ORDER BY rating DESC"
    );
    if (rows.length) return rows;
  } catch (err) {
    console.warn("DB unavailable, using fallback players:", formatDbError(err));
  }
  return fallbackPlayers;
}
