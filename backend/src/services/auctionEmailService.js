import pool from "../db.js";
import { sendAuctionCompletionEmail } from "../mailer.js";
import { normalizePlayerIdList } from "./playing11Rules.js";

export async function loadAuctionEmailSummary(
  { roomDbId, roomCode, sessionNumber, disqualifiedUserIds = [] },
  getPlayerNameById = () => null
) {
  const numericRoomDbId = Number(roomDbId);
  if (!Number.isInteger(numericRoomDbId) || numericRoomDbId <= 0) {
    return null;
  }

  const [participants] = await pool.query(
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
            u.email,
            COALESCE(rp.team_name, t.name, u.username) AS "teamName"
     FROM participant_ids
     JOIN users u ON u.id = participant_ids.user_id
     LEFT JOIN room_players rp ON rp.room_id = ? AND rp.user_id = participant_ids.user_id
     LEFT JOIN teams t ON t.id = rp.team_id
     ORDER BY COALESCE(rp.id, 0) ASC, u.username ASC`,
    [numericRoomDbId, numericRoomDbId, numericRoomDbId, numericRoomDbId, numericRoomDbId]
  );

  if (!participants.length) {
    return null;
  }

  const [squadRows] = await pool.query(
    `SELECT tp.user_id AS "userId",
            c.id,
            c.name,
            c.role,
            c.country,
            tp.price
     FROM team_players tp
     JOIN (
       SELECT room_id, user_id, player_id, MAX(id) AS latest_id
       FROM team_players
       WHERE room_id = ?
       GROUP BY room_id, user_id, player_id
     ) latest ON latest.latest_id = tp.id
     JOIN cricketers c ON c.id = tp.player_id
     WHERE tp.room_id = ?
     ORDER BY tp.user_id, c.role, c.name`,
    [numericRoomDbId, numericRoomDbId]
  );

  const [playing11Rows] = await pool.query(
    `SELECT p11.user_id AS "userId",
            p11.score,
            p11.lineup,
            u.username,
            COALESCE(rp.team_name, t.name, u.username) AS "teamName"
     FROM playing11 p11
     JOIN users u ON u.id = p11.user_id
     LEFT JOIN room_players rp ON rp.room_id = p11.room_id AND rp.user_id = p11.user_id
     LEFT JOIN teams t ON t.id = rp.team_id
     WHERE p11.room_id = ?
     ORDER BY p11.score DESC, COALESCE(rp.team_name, t.name, u.username), u.username`,
    [numericRoomDbId]
  );

  const allPlaying11Ids = Array.from(
    new Set(
      playing11Rows.flatMap((row) => normalizePlayerIdList(row.lineup))
    )
  );

  const [playerRows] = allPlaying11Ids.length
    ? await pool.query(
        `SELECT id, name
         FROM cricketers
         WHERE id = ANY(?::int[])`,
        [allPlaying11Ids]
      )
    : [[]];

  const playerNameById = new Map(
    playerRows.map((row) => [Number(row.id), row.name])
  );

  const leaderboard = playing11Rows.map((row, index) => ({
    rank: index + 1,
    userId: Number(row.userId),
    username: row.username,
    teamName: row.teamName || row.username,
    score: Number(row.score || 0),
    playing11: normalizePlayerIdList(row.lineup)
      .map((playerId) => playerNameById.get(playerId) || getPlayerNameById(playerId))
      .filter(Boolean),
  }));

  const squadByUserId = new Map();
  for (const row of squadRows) {
    const numericUserId = Number(row.userId);
    const existing = squadByUserId.get(numericUserId) || [];
    existing.push({
      id: Number(row.id),
      name: row.name,
      role: row.role,
      country: row.country,
      price: Number(row.price || 0),
    });
    squadByUserId.set(numericUserId, existing);
  }

  const playing11ByUserId = new Map(
    leaderboard.map((entry) => [Number(entry.userId), entry])
  );
  const disqualifiedSet = new Set(
    (Array.isArray(disqualifiedUserIds) ? disqualifiedUserIds : [])
      .map((userId) => Number(userId))
      .filter((userId) => Number.isInteger(userId) && userId > 0)
  );

  return {
    roomCode,
    sessionNumber,
    winnerName: leaderboard[0]?.teamName || leaderboard[0]?.username || "No winner",
    leaderboard,
    recipients: participants
      .map((participant) => {
        const numericUserId = Number(participant.userId);
        const scoredEntry = playing11ByUserId.get(numericUserId);
        return {
          userId: numericUserId,
          username: participant.username,
          email: participant.email || null,
          teamName: participant.teamName || participant.username,
          yourScore: scoredEntry?.score ?? null,
          yourPlaying11: scoredEntry?.playing11 || [],
          yourSquad: squadByUserId.get(numericUserId) || [],
          disqualified: disqualifiedSet.has(numericUserId),
        };
      })
      .filter((participant) => participant.email),
  };
}

export async function sendAuctionCompletionEmails(summaryInput, options = {}) {
  const summary = await loadAuctionEmailSummary(summaryInput, options.getPlayerNameById);
  if (!summary || !summary.recipients.length) {
    return;
  }

  await Promise.allSettled(
    summary.recipients.map((recipient) =>
      sendAuctionCompletionEmail({
        to: recipient.email,
        username: recipient.username,
        teamName: recipient.teamName,
        roomCode: summary.roomCode,
        sessionNumber: summary.sessionNumber,
        winnerName: summary.winnerName,
        yourScore: recipient.yourScore,
        yourSquad: recipient.yourSquad,
        yourPlaying11: recipient.yourPlaying11,
        leaderboard: summary.leaderboard,
        disqualified: recipient.disqualified,
      })
    )
  );
}
