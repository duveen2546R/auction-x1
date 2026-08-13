import express from "express";
import pool, { formatDbError } from "../db.js";
import requireAuth from "../middleware/requireAuth.js";
import { buildStoredRoomOpenInfo } from "../services/roomOpenInfo.js";
import { parseLineupIds } from "../utils/input.js";

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const [rooms] = await pool.query(
      `WITH participant_rooms AS (
         SELECT id AS room_id FROM rooms WHERE host_id = ?
         UNION
         SELECT room_id FROM room_players WHERE user_id = ?
         UNION
         SELECT room_id FROM team_players WHERE user_id = ?
         UNION
         SELECT room_id FROM playing11 WHERE user_id = ?
         UNION
         SELECT room_id FROM bids WHERE user_id = ?
       )
       SELECT r.id, r.room_code AS "roomCode", r.status, r.created_at AS "createdAt",
              r.session_number AS "sessionNumber",
              COALESCE(rp.team_name, t.name, u.username) AS "teamName"
       FROM participant_rooms pr
       JOIN rooms r ON r.id = pr.room_id
       JOIN users u ON u.id = ?
       LEFT JOIN room_players rp ON rp.room_id = r.id AND rp.user_id = u.id
       LEFT JOIN teams t ON t.id = rp.team_id
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT 10`,
      [
        req.auth.userId,
        req.auth.userId,
        req.auth.userId,
        req.auth.userId,
        req.auth.userId,
        req.auth.userId,
      ]
    );

    if (!rooms.length) return res.json({ history: [] });

    const roomIds = rooms
      .map((room) => Number(room.id))
      .filter((id) => Number.isInteger(id) && id > 0);

    const [stateRows] = await pool.query(
      `SELECT DISTINCT ON (room_id)
              room_id AS "roomId",
              state
       FROM auction_state
       WHERE room_id = ANY(?::int[])
       ORDER BY room_id, id DESC`,
      [roomIds]
    );

    const [leaderboardRows] = await pool.query(
      `SELECT p11.room_id AS "roomId", p11.user_id AS "userId", p11.score, p11.lineup,
              u.username, COALESCE(rp.team_name, t.name, u.username) AS "teamName"
       FROM playing11 p11
       JOIN users u ON u.id = p11.user_id
       LEFT JOIN room_players rp ON rp.room_id = p11.room_id AND rp.user_id = p11.user_id
       LEFT JOIN teams t ON t.id = rp.team_id
       WHERE p11.room_id = ANY(?::int[])
       ORDER BY p11.room_id, p11.score DESC, COALESCE(rp.team_name, t.name, u.username), u.username`,
      [roomIds]
    );

    const [squadRows] = await pool.query(
      `SELECT tp.room_id AS "roomId", tp.user_id AS "userId",
              c.id, c.name, c.role, c.country, tp.price
       FROM team_players tp
       JOIN (
         SELECT room_id, user_id, player_id, MAX(id) AS latest_id
         FROM team_players
         WHERE room_id = ANY(?::int[]) AND user_id = ?
         GROUP BY room_id, user_id, player_id
       ) latest ON latest.latest_id = tp.id
       JOIN cricketers c ON c.id = tp.player_id
       WHERE tp.room_id = ANY(?::int[]) AND tp.user_id = ?
       ORDER BY tp.room_id DESC, c.role, c.name`,
      [roomIds, req.auth.userId, roomIds, req.auth.userId]
    );

    const allPlayerIds = Array.from(
      new Set(leaderboardRows.flatMap((row) => parseLineupIds(row.lineup)))
    );
    const [playerRows] = allPlayerIds.length
      ? await pool.query(
          `SELECT id, name
           FROM cricketers
           WHERE id = ANY(?::int[])`,
          [allPlayerIds]
        )
      : [[]];
    const playerNameById = new Map(
      playerRows.map((player) => [Number(player.id), player.name])
    );

    const leaderboardByRoom = new Map();
    for (const row of leaderboardRows) {
      const roomId = Number(row.roomId);
      const existingEntries = leaderboardByRoom.get(roomId) || [];
      existingEntries.push({
        userId: Number(row.userId),
        username: row.username,
        teamName: row.teamName || row.username,
        score: Number(row.score || 0),
        playing11: parseLineupIds(row.lineup)
          .map((playerId) => playerNameById.get(playerId))
          .filter(Boolean),
      });
      leaderboardByRoom.set(roomId, existingEntries);
    }

    const squadByRoom = new Map();
    for (const row of squadRows) {
      const roomId = Number(row.roomId);
      const existingEntries = squadByRoom.get(roomId) || [];
      existingEntries.push({
        id: Number(row.id),
        name: row.name,
        role: row.role,
        country: row.country,
        price: Number(row.price || 0),
      });
      squadByRoom.set(roomId, existingEntries);
    }

    const stateByRoom = new Map(
      stateRows.map((row) => [Number(row.roomId), row.state || null])
    );

    const history = rooms.map((room) => {
      const openInfo = buildStoredRoomOpenInfo(
        room,
        stateByRoom.get(Number(room.id)) || null
      );
      const leaderboard = (leaderboardByRoom.get(Number(room.id)) || []).map(
        (entry, index) => ({
          rank: index + 1,
          userId: entry.userId,
          username: entry.username,
          teamName: entry.teamName,
          score: entry.score,
          playing11: entry.playing11,
        })
      );
      const currentUserEntry = (leaderboardByRoom.get(Number(room.id)) || []).find(
        (entry) => Number(entry.userId) === Number(req.auth.userId)
      );
      const effectiveStatus =
        room.status === "finished" && !openInfo.canOpen ? "finished" : openInfo.status;
      const winnerName =
        leaderboard[0]?.teamName ||
        leaderboard[0]?.username ||
        (effectiveStatus === "finished" || effectiveStatus === "closed" ? "No Result" : null);

      return {
        roomId: Number(room.id),
        roomCode: room.roomCode,
        sessionNumber: Number(room.sessionNumber || 1),
        status: effectiveStatus,
        createdAt: room.createdAt,
        teamName: room.teamName,
        winnerName,
        yourScore: typeof currentUserEntry?.score === "number" ? currentUserEntry.score : null,
        yourPlaying11: currentUserEntry?.playing11 || [],
        yourSquad: squadByRoom.get(Number(room.id)) || [],
        canOpen: openInfo.canOpen,
        openTarget: openInfo.openTarget,
        leaderboard,
      };
    });

    return res.json({ history });
  } catch (err) {
    console.error("Failed to fetch user history", formatDbError(err));
    return res.status(500).json({ error: "Failed to fetch user history" });
  }
});

export default router;
