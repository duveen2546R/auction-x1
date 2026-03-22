import express from "express";
import pool, { formatDbError } from "./db.js";
import { loadPlayers } from "./playerStore.js";
import { loadTeams } from "./teamStore.js";

const router = express.Router();

async function resolveRoom(roomIdentifier) {
  const roomCode = String(roomIdentifier || "").trim();
  if (!roomCode) return null;

  const [codeRows] = await pool.query(
    "SELECT id, room_code FROM rooms WHERE room_code = ? LIMIT 1",
    [roomCode]
  );
  if (codeRows.length) {
    return codeRows[0];
  }

  const numericId = Number(roomCode);
  if (!Number.isInteger(numericId)) return null;

  const [idRows] = await pool.query(
    "SELECT id, room_code FROM rooms WHERE id = ? LIMIT 1",
    [numericId]
  );
  return idRows[0] || null;
}

async function resolveRoomUserId(roomDbId, query) {
  const userId = Number(query?.userId);
  if (Number.isInteger(userId) && userId > 0) {
    return userId;
  }

  const username = String(query?.user || "").trim();
  if (!username) return null;

  const [rows] = await pool.query(
    `SELECT rp.user_id
     FROM room_players rp
     JOIN users u ON u.id = rp.user_id
     WHERE rp.room_id = ? AND u.username = ?
     LIMIT 1`,
    [roomDbId, username]
  );

  return rows[0]?.user_id || null;
}

router.get("/health", (_req, res) => res.json({ ok: true }));

router.get("/players", async (_req, res) => {
  const players = await loadPlayers();
  res.json(players);
});

router.get("/teams", async (_req, res) => {
  const teams = await loadTeams();
  res.json(teams);
});

// Sold vs remaining players for a given room (backed by DB)
router.get("/rooms/:roomId/players-status", async (req, res) => {
  const roomKey = String(req.params.roomId || "").trim();
  if (!roomKey) {
    return res.status(400).json({ error: "roomId is required" });
  }

  try {
    const room = await resolveRoom(roomKey);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    const [sold] = await pool.query(
      `SELECT c.id, c.name, c.role, c.batting_rating, c.bowling_rating, c.rating, c.base_price, c.country, tp.price
       FROM team_players tp
       JOIN (
         SELECT player_id, MAX(id) AS latest_id
         FROM team_players
         WHERE room_id = ?
         GROUP BY player_id
       ) latest ON latest.latest_id = tp.id
       JOIN cricketers c ON c.id = tp.player_id
       WHERE tp.room_id = ?
       ORDER BY c.role, c.name`,
      [room.id, room.id]
    );

    const [remaining] = await pool.query(
      `SELECT c.id, c.name, c.role, c.batting_rating, c.bowling_rating, c.rating, c.base_price, c.country
       FROM cricketers c
       LEFT JOIN (
         SELECT DISTINCT player_id FROM team_players WHERE room_id = ?
       ) sold ON sold.player_id = c.id
       WHERE sold.player_id IS NULL
       ORDER BY c.role, c.name`,
      [room.id]
    );

    const resolvedUserId = await resolveRoomUserId(room.id, req.query);
    let userTeam = [];
    let userBudget = null;

    if (resolvedUserId) {
      const [teamRows] = await pool.query(
        `SELECT c.id, c.name, c.role, c.batting_rating, c.bowling_rating, c.rating, c.base_price, c.country, tp.price
         FROM team_players tp
         JOIN (
           SELECT player_id, MAX(id) AS latest_id
           FROM team_players
           WHERE room_id = ? AND user_id = ?
           GROUP BY player_id
         ) latest ON latest.latest_id = tp.id
         JOIN cricketers c ON c.id = tp.player_id
         WHERE tp.room_id = ? AND tp.user_id = ?
         ORDER BY c.role, c.name`,
        [room.id, resolvedUserId, room.id, resolvedUserId]
      );
      userTeam = teamRows;

      const [budgetRows] = await pool.query(
        "SELECT budget FROM room_players WHERE room_id = ? AND user_id = ? LIMIT 1",
        [room.id, resolvedUserId]
      );
      if (budgetRows.length) {
        userBudget = Number(budgetRows[0].budget ?? 100);
      }
    }

    return res.json({
      roomId: room.room_code,
      roomDbId: room.id,
      sold,
      remaining,
      counts: { sold: sold.length, remaining: remaining.length },
      userTeam,
      userBudget,
    });
  } catch (err) {
    console.error("Failed to fetch player status", formatDbError(err));
    // Fallback to in-memory list so the API still returns data if DB is down
    const fallbackPlayers = await loadPlayers();
    return res.status(200).json({
      roomId: roomKey,
      sold: [],
      remaining: fallbackPlayers,
      counts: { sold: 0, remaining: fallbackPlayers.length },
      userTeam: [],
      userBudget: null,
      warning: "DB unavailable; returning fallback player list",
    });
  }
});

router.get("/rooms/:roomId/purses", async (req, res) => {
  const roomKey = String(req.params.roomId || "").trim();
  if (!roomKey) {
    return res.status(400).json({ error: "roomId is required" });
  }

  try {
    const room = await resolveRoom(roomKey);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    const [purses] = await pool.query(
      `SELECT rp.user_id AS "userId", u.username, rp.team_name AS "teamName", rp.budget
       FROM room_players rp
       JOIN (
         SELECT user_id, MAX(id) AS latest_id
         FROM room_players
         WHERE room_id = ?
         GROUP BY user_id
       ) latest ON latest.latest_id = rp.id
       JOIN users u ON u.id = rp.user_id
       WHERE rp.room_id = ?
       ORDER BY rp.team_name, u.username`,
      [room.id, room.id]
    );

    const [purchasedPlayers] = await pool.query(
      `SELECT tp.user_id AS "userId", c.id, c.name, c.role, c.country, tp.price
       FROM team_players tp
       JOIN (
         SELECT player_id, MAX(id) AS latest_id
         FROM team_players
         WHERE room_id = ?
         GROUP BY player_id
       ) latest ON latest.latest_id = tp.id
       JOIN cricketers c ON c.id = tp.player_id
       WHERE tp.room_id = ?
       ORDER BY tp.user_id, tp.id`,
      [room.id, room.id]
    );

    const playersByUser = new Map();
    for (const player of purchasedPlayers) {
      const existing = playersByUser.get(player.userId) || [];
      existing.push(player);
      playersByUser.set(player.userId, existing);
    }

    const enrichedPurses = purses.map((entry) => ({
      ...entry,
      players: playersByUser.get(entry.userId) || [],
    }));

    return res.json({
      roomId: room.room_code,
      roomDbId: room.id,
      purses: enrichedPurses,
    });
  } catch (err) {
    console.error("Failed to fetch purses", formatDbError(err));
    return res.status(200).json({
      roomId: roomKey,
      purses: [],
      warning: "DB unavailable; returning empty purse list",
    });
  }
});

export default router;
