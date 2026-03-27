import express from "express";
import pool, { formatDbError } from "./db.js";
import { loadPlayers } from "./playerStore.js";
import { loadTeams } from "./teamStore.js";
import { hashPassword, signAuthToken, verifyAuthToken, verifyPassword } from "./auth.js";
import { resolveRoom } from "./roomSessions.js";
import { isRuntimeRoomOpenable } from "./runtimeRooms.js";

const router = express.Router();

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

function normalizeUsernameInput(value) {
  const username = String(value || "").trim().replace(/\s+/g, " ");
  if (username.length < 3 || username.length > 50) return null;
  return username;
}

function normalizePasswordInput(value) {
  return String(value || "");
}

async function findUserByUsername(username) {
  const [rows] = await pool.query(
    `SELECT id, username, password_hash AS "passwordHash"
     FROM users
     WHERE LOWER(username) = LOWER(?)
     LIMIT 1`,
    [username]
  );

  return rows[0] || null;
}

function buildAuthResponse(user) {
  return {
    token: signAuthToken(user),
    user: {
      id: Number(user.id),
      username: user.username,
    },
  };
}

function requireAuth(req, res, next) {
  const authHeader = String(req.headers.authorization || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    req.auth = verifyAuthToken(token);
    return next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

function parseLineupIds(lineup) {
  if (!Array.isArray(lineup)) return [];
  return lineup.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
}

router.get("/health", (_req, res) => res.json({ ok: true }));

router.get("/rooms/:roomId/joinability", async (req, res) => {
  const roomKey = String(req.params.roomId || "").trim();
  if (!roomKey) {
    return res.status(400).json({ error: "roomId is required" });
  }

  try {
    const room = await resolveRoom(pool, roomKey);
    if (!room) {
      return res.json({ exists: false, status: null });
    }

    const exists = room.status !== "finished" || isRuntimeRoomOpenable(roomKey, room.id);
    return res.json({
      exists,
      status: exists ? room.status : "closed",
      roomId: Number(room.id),
      roomCode: room.roomCode,
    });
  } catch (err) {
    console.error("Failed to check room joinability", formatDbError(err));
    return res.status(500).json({ error: "Failed to verify room code" });
  }
});

router.get("/players", async (_req, res) => {
  const players = await loadPlayers();
  res.json(players);
});

router.get("/teams", async (_req, res) => {
  const teams = await loadTeams();
  res.json(teams);
});

router.post("/auth/register", async (req, res) => {
  const username = normalizeUsernameInput(req.body?.username);
  const password = normalizePasswordInput(req.body?.password);

  if (!username) {
    return res.status(400).json({ error: "Username must be between 3 and 50 characters" });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  try {
    const existingUser = await findUserByUsername(username);
    const passwordHash = await hashPassword(password);

    if (existingUser?.passwordHash) {
      return res.status(409).json({ error: "Username is already registered" });
    }

    let user;
    if (existingUser) {
      await pool.query(
        "UPDATE users SET username = ?, password_hash = ? WHERE id = ?",
        [username, passwordHash, existingUser.id]
      );
      user = {
        id: existingUser.id,
        username,
      };
    } else {
      const [insertResult] = await pool.query(
        "INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id, username",
        [username, passwordHash]
      );
      user = insertResult.rows?.[0] || { id: insertResult.insertId, username };
    }

    return res.status(201).json(buildAuthResponse(user));
  } catch (err) {
    console.error("Failed to register user", formatDbError(err));
    return res.status(500).json({ error: "Failed to register user" });
  }
});

router.post("/auth/login", async (req, res) => {
  const username = normalizeUsernameInput(req.body?.username);
  const password = normalizePasswordInput(req.body?.password);

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  try {
    const user = await findUserByUsername(username);
    if (!user?.passwordHash) {
      return res.status(401).json({ error: "This username is not registered yet" });
    }

    const matches = await verifyPassword(password, user.passwordHash);
    if (!matches) {
      return res.status(401).json({ error: "Incorrect username or password" });
    }

    return res.json(buildAuthResponse(user));
  } catch (err) {
    console.error("Failed to log in user", formatDbError(err));
    return res.status(500).json({ error: "Failed to log in" });
  }
});

router.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, username FROM users WHERE id = ? LIMIT 1",
      [req.auth.userId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({
      user: {
        id: Number(rows[0].id),
        username: rows[0].username,
      },
    });
  } catch (err) {
    console.error("Failed to fetch session user", formatDbError(err));
    return res.status(500).json({ error: "Failed to fetch session" });
  }
});

// Sold vs remaining players for a given room (backed by DB)
router.get("/rooms/:roomId/players-status", async (req, res) => {
  const roomKey = String(req.params.roomId || "").trim();
  if (!roomKey) {
    return res.status(400).json({ error: "roomId is required" });
  }

  try {
    const room = await resolveRoom(pool, roomKey);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    const [sold] = await pool.query(
      `SELECT 
         c.id, c.name, c.role, c.batting_rating, c.bowling_rating, c.rating, c.base_price, c.country, 
         tp.price, COALESCE(rp.team_name, u.username) AS "soldTo"
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
      if (budgetRows.length) {
        userBudget = Number(budgetRows[0].budget ?? 120);
      }
    }

    return res.json({
      roomId: room.room_code,
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
    const room = await resolveRoom(pool, roomKey);
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

router.get("/user/history", requireAuth, async (req, res) => {
  try {
    const [rooms] = await pool.query(
      `SELECT r.id, r.room_code AS "roomCode", r.status, r.created_at AS "createdAt",
              r.session_number AS "sessionNumber",
              COALESCE(rp.team_name, u.username) AS "teamName"
       FROM room_players rp
       JOIN rooms r ON r.id = rp.room_id
       JOIN users u ON u.id = rp.user_id
       WHERE rp.user_id = ?
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT 10`,
      [req.auth.userId]
    );

    if (!rooms.length) {
      return res.json({ history: [] });
    }

    const roomIds = rooms.map((room) => Number(room.id)).filter((id) => Number.isInteger(id) && id > 0);

    const [leaderboardRows] = await pool.query(
      `SELECT p11.room_id AS "roomId", p11.user_id AS "userId", p11.score, p11.lineup,
              u.username, COALESCE(rp.team_name, u.username) AS "teamName"
       FROM playing11 p11
       JOIN users u ON u.id = p11.user_id
       LEFT JOIN room_players rp ON rp.room_id = p11.room_id AND rp.user_id = p11.user_id
       WHERE p11.room_id = ANY(?::int[])
       ORDER BY p11.room_id, p11.score DESC, COALESCE(rp.team_name, u.username), u.username`,
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
      new Set(
        leaderboardRows.flatMap((row) => parseLineupIds(row.lineup))
      )
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
      const playing11 = parseLineupIds(row.lineup)
        .map((playerId) => playerNameById.get(playerId))
        .filter(Boolean);

      existingEntries.push({
        userId: Number(row.userId),
        username: row.username,
        teamName: row.teamName || row.username,
        score: Number(row.score || 0),
        playing11,
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

    const history = rooms.map((room) => {
      const canOpen = isRuntimeRoomOpenable(room.roomCode, room.id);
      const leaderboard = (leaderboardByRoom.get(Number(room.id)) || []).map((entry, index) => ({
        rank: index + 1,
        userId: entry.userId,
        username: entry.username,
        teamName: entry.teamName,
        score: entry.score,
      }));

      const currentUserEntry = (leaderboardByRoom.get(Number(room.id)) || []).find(
        (entry) => Number(entry.userId) === Number(req.auth.userId)
      );

      const effectiveStatus =
        room.status === "finished" ? "finished" : canOpen ? room.status : "closed";
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
        canOpen,
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
