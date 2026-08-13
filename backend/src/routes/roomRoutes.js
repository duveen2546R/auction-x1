import express from "express";
import pool, { formatDbError } from "../db.js";
import { loadPlayers } from "../playerStore.js";
import { resolveRoom } from "../roomSessions.js";
import { getRuntimeRoomForSession } from "../runtimeRooms.js";
import { mergePurseEntries } from "../purseUtils.js";
import { buildStoredRoomOpenInfo } from "../services/roomOpenInfo.js";

const router = express.Router();

async function resolveRoomUserId(roomDbId, query) {
  const userId = Number(query?.userId);
  if (Number.isInteger(userId) && userId > 0) return userId;

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

router.get("/:roomId/joinability", async (req, res) => {
  const roomKey = String(req.params.roomId || "").trim();
  if (!roomKey) {
    return res.status(400).json({ error: "roomId is required" });
  }

  try {
    const room = await resolveRoom(pool, roomKey);
    if (!room) return res.json({ exists: false, status: null });

    const [stateRows] = await pool.query(
      "SELECT state FROM auction_state WHERE room_id = ? LIMIT 1",
      [room.id]
    );
    const openInfo = buildStoredRoomOpenInfo(room, stateRows[0]?.state || null);
    return res.json({
      exists: openInfo.canOpen,
      status: openInfo.status,
      openTarget: openInfo.openTarget,
      roomId: Number(room.id),
      roomCode: room.roomCode,
    });
  } catch (err) {
    console.error("Failed to check room joinability", formatDbError(err));
    return res.status(500).json({ error: "Failed to verify room code" });
  }
});

router.get("/:roomId/players-status", async (req, res) => {
  const roomKey = String(req.params.roomId || "").trim();
  if (!roomKey) {
    return res.status(400).json({ error: "roomId is required" });
  }

  try {
    const room = await resolveRoom(pool, roomKey);
    if (!room) return res.status(404).json({ error: "Room not found" });

    const [sold] = await pool.query(
      `SELECT
         c.id, c.name, c.role, c.batting_rating, c.bowling_rating, c.rating, c.base_price, c.country,
         tp.price, COALESCE(rp.team_name, t.name, u.username) AS "soldTo"
       FROM team_players tp
       JOIN (
         SELECT player_id, MAX(id) AS latest_id
         FROM team_players
         WHERE room_id = ?
         GROUP BY player_id
       ) latest ON latest.latest_id = tp.id
       JOIN cricketers c ON c.id = tp.player_id
       JOIN users u ON u.id = tp.user_id
       LEFT JOIN room_players rp ON rp.room_id = tp.room_id AND rp.user_id = tp.user_id
       LEFT JOIN teams t ON t.id = rp.team_id
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
       LEFT JOIN (
         SELECT DISTINCT player_id FROM unsold_players WHERE room_id = ?
       ) unsold_tbl ON unsold_tbl.player_id = c.id
       WHERE sold.player_id IS NULL AND unsold_tbl.player_id IS NULL
       ORDER BY c.role, c.name`,
      [room.id, room.id]
    );

    const [unsold] = await pool.query(
      `SELECT c.id, c.name, c.role, c.batting_rating, c.bowling_rating, c.rating, c.base_price, c.country
       FROM unsold_players up
       JOIN cricketers c ON c.id = up.player_id
       WHERE up.room_id = ?
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
      if (budgetRows.length) userBudget = Number(budgetRows[0].budget ?? 120);
    }

    return res.json({
      roomId: room.roomCode,
      roomDbId: room.id,
      sold,
      remaining,
      unsold,
      counts: { sold: sold.length, remaining: remaining.length, unsold: unsold.length },
      userTeam,
      userBudget,
    });
  } catch (err) {
    console.error("Failed to fetch player status", formatDbError(err));
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

router.get("/:roomId/purses", async (req, res) => {
  const roomKey = String(req.params.roomId || "").trim();
  if (!roomKey) {
    return res.status(400).json({ error: "roomId is required" });
  }

  try {
    const room = await resolveRoom(pool, roomKey);
    if (!room) return res.status(404).json({ error: "Room not found" });

    const [purses] = await pool.query(
      `SELECT rp.user_id AS "userId",
              u.username,
              COALESCE(rp.team_name, t.name) AS "teamName",
              rp.budget
       FROM room_players rp
       JOIN (
         SELECT user_id, MAX(id) AS latest_id
         FROM room_players
         WHERE room_id = ?
         GROUP BY user_id
       ) latest ON latest.latest_id = rp.id
       JOIN users u ON u.id = rp.user_id
       LEFT JOIN teams t ON t.id = rp.team_id
       WHERE rp.room_id = ?
       ORDER BY COALESCE(rp.team_name, t.name), u.username`,
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

    const persistedPurses = purses.map((entry) => ({
      ...entry,
      players: playersByUser.get(entry.userId) || [],
    }));
    const runtimeRoom = getRuntimeRoomForSession(room.roomCode, room.id);
    const runtimePurses = runtimeRoom
      ? Array.from(runtimeRoom.users.values())
          .filter(
            (user) =>
              user && (user.teamName || (Array.isArray(user.team) && user.team.length > 0))
          )
          .map((user) => ({
            userId: Number(user.userId || 0) || null,
            username: user.username || null,
            teamName: user.teamName || null,
            budget: Number(user.budget ?? 0),
            players: Array.isArray(user.team) ? user.team : [],
          }))
      : [];

    return res.json({
      roomId: room.roomCode,
      roomDbId: room.id,
      purses: mergePurseEntries(persistedPurses, runtimePurses),
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
