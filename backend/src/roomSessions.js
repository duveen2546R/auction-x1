function normalizeRoomRow(row) {
  if (!row) return null;

  return {
    id: Number(row.id),
    roomCode: row.roomCode || row.room_code,
    hostId: row.hostId != null ? Number(row.hostId) : row.host_id != null ? Number(row.host_id) : null,
    status: row.status || "waiting",
    createdAt: row.createdAt || row.created_at || null,
    sessionNumber: Number(row.sessionNumber || row.session_number || 1),
  };
}

export async function ensureRoomSessionSchema(pool) {
  await pool.query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS session_number INT");
  await pool.query("UPDATE rooms SET session_number = 1 WHERE session_number IS NULL");
  await pool.query("ALTER TABLE rooms ALTER COLUMN session_number SET DEFAULT 1");
  await pool.query("ALTER TABLE rooms ALTER COLUMN session_number SET NOT NULL");
  await pool.query("ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_room_code_key");
  await pool.query("DROP INDEX IF EXISTS rooms_room_code_key");

  await pool.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS rooms_room_code_session_number_key ON rooms (room_code, session_number)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS rooms_room_code_latest_idx ON rooms (room_code, session_number DESC, id DESC)"
  );
}

export async function getLatestRoomSession(pool, roomCode, options = {}) {
  const cleanRoomCode = String(roomCode || "").trim();
  if (!cleanRoomCode) return null;

  const filters = ["room_code = ?"];
  const params = [cleanRoomCode];

  if (options.joinableOnly) {
    filters.push("status != 'finished'");
  }

  const [rows] = await pool.query(
    `SELECT id,
            room_code AS "roomCode",
            host_id AS "hostId",
            status,
            created_at AS "createdAt",
            session_number AS "sessionNumber"
     FROM rooms
     WHERE ${filters.join(" AND ")}
     ORDER BY session_number DESC, id DESC
     LIMIT 1`,
    params
  );

  return normalizeRoomRow(rows[0]);
}

export async function getRoomSessionById(pool, roomDbId) {
  const numericId = Number(roomDbId);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;

  const [rows] = await pool.query(
    `SELECT id,
            room_code AS "roomCode",
            host_id AS "hostId",
            status,
            created_at AS "createdAt",
            session_number AS "sessionNumber"
     FROM rooms
     WHERE id = ?
     LIMIT 1`,
    [numericId]
  );

  return normalizeRoomRow(rows[0]);
}

export async function createRoomSession(pool, roomCode, hostUserId, attempts = 3) {
  const cleanRoomCode = String(roomCode || "").trim();
  const cleanHostUserId = Number(hostUserId);

  if (!cleanRoomCode) {
    throw new Error("roomCode is required");
  }

  if (!Number.isInteger(cleanHostUserId) || cleanHostUserId <= 0) {
    throw new Error("hostUserId must be a valid positive integer");
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const [insertResult] = await pool.query(
        `WITH next_session AS (
           SELECT COALESCE(MAX(session_number), 0) + 1 AS "sessionNumber"
           FROM rooms
           WHERE room_code = ?
         )
         INSERT INTO rooms (room_code, host_id, status, session_number)
         SELECT ?, ?, 'waiting', "sessionNumber"
         FROM next_session
         RETURNING id,
                   room_code AS "roomCode",
                   host_id AS "hostId",
                   status,
                   created_at AS "createdAt",
                   session_number AS "sessionNumber"`,
        [cleanRoomCode, cleanRoomCode, cleanHostUserId]
      );

      return normalizeRoomRow(insertResult.rows?.[0]);
    } catch (error) {
      if (error?.code === "23505" && attempt < attempts - 1) {
        continue;
      }
      throw error;
    }
  }

  return null;
}

export async function resolveRoom(pool, roomIdentifier) {
  const roomCode = String(roomIdentifier || "").trim();
  if (!roomCode) return null;

  const latestByCode = await getLatestRoomSession(pool, roomCode);
  if (latestByCode) {
    return latestByCode;
  }

  const numericId = Number(roomCode);
  if (!Number.isInteger(numericId)) return null;

  return getRoomSessionById(pool, numericId);
}
