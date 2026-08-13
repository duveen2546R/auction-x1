import pool, { formatDbError } from "../db.js";
import { calculateScore, normalizePlayerIdList } from "../services/playing11Rules.js";

export async function findPersistedRoomParticipant(roomDbId, { userId, username } = {}) {
  const numericRoomDbId = Number(roomDbId);
  if (!Number.isInteger(numericRoomDbId) || numericRoomDbId <= 0) {
    return null;
  }

  const filters = [];
  const filterParams = [];
  const numericUserId = Number(userId);
  const cleanUsername = String(username || "").trim();

  if (Number.isInteger(numericUserId) && numericUserId > 0) {
    filters.push("participant_ids.user_id = ?");
    filterParams.push(numericUserId);
  }
  if (cleanUsername) {
    filters.push("LOWER(u.username) = LOWER(?)");
    filterParams.push(cleanUsername);
  }

  if (!filters.length) {
    return null;
  }

  const [rows] = await pool.query(
    `WITH participant_ids AS (
       SELECT user_id FROM room_players WHERE room_id = ?
       UNION
       SELECT user_id FROM team_players WHERE room_id = ?
       UNION
       SELECT user_id FROM playing11 WHERE room_id = ?
       UNION
       SELECT user_id FROM bids WHERE room_id = ?
     )
     SELECT participant_ids.user_id AS "userId",
            u.username,
            COALESCE(rp.team_name, t.name) AS "teamName"
     FROM participant_ids
     JOIN users u ON u.id = participant_ids.user_id
     LEFT JOIN room_players rp ON rp.room_id = ? AND rp.user_id = participant_ids.user_id
     LEFT JOIN teams t ON t.id = rp.team_id
     WHERE 1 = 1
       AND (${filters.join(" OR ")})
     ORDER BY COALESCE(rp.id, 0) ASC, u.username ASC
     LIMIT 1`,
    [
      numericRoomDbId,
      numericRoomDbId,
      numericRoomDbId,
      numericRoomDbId,
      numericRoomDbId,
      ...filterParams,
    ]
  );

  if (!rows.length) {
    return null;
  }

  return {
    userId: Number(rows[0].userId) || null,
    username: rows[0].username || null,
    teamName: rows[0].teamName || null,
  };
}

export async function hasPersistedRoomPresence(roomDbId, userId) {
  const numericRoomDbId = Number(roomDbId);
  const numericUserId = Number(userId);

  if (!Number.isInteger(numericRoomDbId) || numericRoomDbId <= 0) {
    return false;
  }

  if (!Number.isInteger(numericUserId) || numericUserId <= 0) {
    return false;
  }

  const [rows] = await pool.query(
    `SELECT user_id
     FROM (
       SELECT user_id FROM room_players WHERE room_id = ?
       UNION
       SELECT user_id FROM team_players WHERE room_id = ?
       UNION
       SELECT user_id FROM playing11 WHERE room_id = ?
       UNION
       SELECT user_id FROM bids WHERE room_id = ?
     ) participant_ids
     WHERE user_id = ?
     LIMIT 1`,
    [numericRoomDbId, numericRoomDbId, numericRoomDbId, numericRoomDbId, numericUserId]
  );

  return rows.length > 0;
}

export async function clearAuctionState(roomDbId) {
  const numericRoomDbId = Number(roomDbId);
  if (!Number.isInteger(numericRoomDbId) || numericRoomDbId <= 0) return;

  await pool
    .query("DELETE FROM auction_state WHERE room_id = ?", [numericRoomDbId])
    .catch((err) => console.error("Failed to clear auction state", formatDbError(err)));
}

export async function loadStoredAuctionState(roomDbId) {
  const numericRoomDbId = Number(roomDbId);
  if (!Number.isInteger(numericRoomDbId) || numericRoomDbId <= 0) return null;

  const [stateRows] = await pool.query(
    "SELECT state FROM auction_state WHERE room_id = ? LIMIT 1",
    [numericRoomDbId]
  );

  return stateRows[0]?.state || null;
}

export function isRecoverableStoredState(state) {
  const status = String(state?.status || "").trim();
  return ["starting", "transitioning", "running", "sold", "picking", "finished_finalized"].includes(status);
}

export async function loadPersistedRoomUsers(roomDbId) {
  const [participants] = await pool.query(
    `SELECT rp.user_id AS "userId",
            u.username,
            rp.budget,
            COALESCE(rp.team_name, t.name) AS "teamName"
     FROM room_players rp
     JOIN users u ON u.id = rp.user_id
     LEFT JOIN teams t ON t.id = rp.team_id
     WHERE rp.room_id = ?
     ORDER BY rp.id ASC`,
    [roomDbId]
  );

  const [teamRows] = await pool.query(
    `SELECT tp.user_id AS "userId",
            c.id,
            c.name,
            c.role,
            c.batting_rating,
            c.bowling_rating,
            c.rating,
            c.base_price,
            c.country,
            tp.price
     FROM team_players tp
     JOIN (
       SELECT player_id, MAX(id) AS latest_id
       FROM team_players
       WHERE room_id = ?
       GROUP BY player_id
     ) latest ON latest.latest_id = tp.id
     JOIN cricketers c ON c.id = tp.player_id
     WHERE tp.room_id = ?
     ORDER BY tp.user_id, c.role, c.name`,
    [roomDbId, roomDbId]
  );

  const teamByUserId = new Map();
  for (const row of teamRows) {
    const userId = Number(row.userId);
    const existing = teamByUserId.get(userId) || [];
    existing.push(row);
    teamByUserId.set(userId, existing);
  }

  return participants.map((participant) => {
    const userId = Number(participant.userId);
    const team = teamByUserId.get(userId) || [];
    return {
      username: participant.username,
      team,
      score: calculateScore(team),
      budget: Number(participant.budget ?? 120),
      userId,
      teamName: participant.teamName || null,
    };
  });
}

export async function loadPersistedPlaying11Entries(roomDbId) {
  const [rows] = await pool.query(
    `SELECT user_id AS "userId", lineup, score
     FROM playing11
     WHERE room_id = ?`,
    [roomDbId]
  );

  return rows.map((row) => ({
    userId: Number(row.userId),
    score: Number(row.score || 0),
    playerIds: normalizePlayerIdList(row.lineup),
  }));
}

export async function finishPersistedRoomSession(roomDbId) {
  const numericRoomDbId = Number(roomDbId);
  if (!Number.isInteger(numericRoomDbId) || numericRoomDbId <= 0) return;

  await pool
    .query("UPDATE rooms SET status = 'finished' WHERE id = ?", [numericRoomDbId])
    .catch((err) => console.error("Failed to mark persisted room finished", formatDbError(err)));
  await clearAuctionState(numericRoomDbId);
}

export async function loadUnfinishedRoomSnapshots() {
  const [rows] = await pool.query(
    `SELECT r.id,
            r.room_code AS "roomCode",
            r.host_id AS "hostId",
            r.status,
            r.created_at AS "createdAt",
            r.session_number AS "sessionNumber",
            s.state
     FROM rooms r
     LEFT JOIN (
       SELECT DISTINCT ON (room_id) room_id, state
       FROM auction_state
       ORDER BY room_id, id DESC
     ) s ON s.room_id = r.id
     WHERE r.status != 'finished'
     ORDER BY r.created_at DESC, r.id DESC`
  );

  return rows.map((row) => ({
    id: Number(row.id),
    roomCode: row.roomCode,
    hostId: row.hostId != null ? Number(row.hostId) : null,
    status: row.status,
    createdAt: row.createdAt,
    sessionNumber: Number(row.sessionNumber || 1),
    state: row.state || null,
  }));
}

export async function ensureRoomPlayerRow(roomDbId, userId, teamName, teamId) {
  let initialBudget = 120;
  if (teamId) {
    try {
      const [teams] = await pool.query("SELECT budget FROM teams WHERE id = ?", [teamId]);
      if (teams.length) {
        initialBudget = Number(teams[0].budget);
        console.log(`Setting initial budget for user ${userId} in room ${roomDbId} from team ${teamId}: ${initialBudget}`);
      }
    } catch (err) {
      console.warn("Failed to fetch team budget", err.message);
    }
  }

  const [upsertResult] = await pool.query(
    `INSERT INTO room_players (room_id, user_id, budget, team_name, team_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (room_id, user_id)
     DO UPDATE SET
       team_name = COALESCE(EXCLUDED.team_name, room_players.team_name),
       team_id = COALESCE(EXCLUDED.team_id, room_players.team_id)
     RETURNING id, budget, team_name AS "teamName", team_id AS "teamId"`,
    [roomDbId, userId, initialBudget, teamName, teamId]
  );

  const row = upsertResult.rows?.[0] || null;
  if (row?.budget != null && Number(row.budget) !== Number(initialBudget)) {
    console.log(`Found existing room_player row for user ${userId} in room ${roomDbId}. Current budget: ${row.budget}`);
  }

  return {
    budget: Number(row?.budget ?? initialBudget),
    teamName: row?.teamName || teamName || null,
    teamId: Number(row?.teamId || teamId || 0) || null,
    duplicateCount: 0,
  };
}

export async function resolveTeamIdByName(teamName) {
  const cleanTeamName = String(teamName || "").trim();
  if (!cleanTeamName) return null;

  const [teamRows] = await pool.query(
    "SELECT id FROM teams WHERE LOWER(name) = LOWER(?) LIMIT 1",
    [cleanTeamName]
  );

  return Number(teamRows?.[0]?.id || 0) || null;
}

export async function ensureRoomPlayerIdentity(roomDbId, user) {
  const numericRoomDbId = Number(roomDbId);
  const numericUserId = Number(user?.userId || 0);
  if (!Number.isInteger(numericRoomDbId) || numericRoomDbId <= 0) return null;
  if (!Number.isInteger(numericUserId) || numericUserId <= 0) return null;

  let teamId = null;
  if (user?.teamName) {
    teamId = await resolveTeamIdByName(user.teamName).catch((err) => {
      console.warn("Failed to resolve team id for room player repair", formatDbError(err));
      return null;
    });
  }

  return ensureRoomPlayerRow(numericRoomDbId, numericUserId, user?.teamName || null, teamId);
}

export async function persistPlaying11(roomDbId, userId, lineup, score) {
  const serializedLineup = JSON.stringify(lineup);
  const [updateResult] = await pool.query(
    "UPDATE playing11 SET lineup = ?::jsonb, score = ? WHERE room_id = ? AND user_id = ?",
    [serializedLineup, score, roomDbId, userId]
  );

  if (updateResult.rowCount === 0) {
    await pool.query(
      "INSERT INTO playing11 (room_id, user_id, lineup, score) VALUES (?, ?, ?::jsonb, ?)",
      [roomDbId, userId, serializedLineup, score]
    );
  }
}

export async function getResolvedPlayerIds(roomDbId, playerIds = []) {
  const uniqueIds = Array.from(
    new Set(
      (Array.isArray(playerIds) ? playerIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
  if (!roomDbId || uniqueIds.length === 0) {
    return new Set();
  }

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const params = [roomDbId, ...uniqueIds];

  try {
    const [soldRows] = await pool.query(
      `SELECT DISTINCT player_id AS "playerId"
       FROM team_players
       WHERE room_id = ?
         AND player_id IN (${placeholders})`,
      params
    );
    const [unsoldRows] = await pool.query(
      `SELECT DISTINCT player_id AS "playerId"
       FROM unsold_players
       WHERE room_id = ?
         AND player_id IN (${placeholders})`,
      params
    );

    return new Set(
      [...soldRows, ...unsoldRows]
        .map((row) => Number(row.playerId))
        .filter((value) => Number.isInteger(value) && value > 0)
    );
  } catch (err) {
    console.error("Failed to load resolved players", formatDbError(err));
    return new Set();
  }
}
