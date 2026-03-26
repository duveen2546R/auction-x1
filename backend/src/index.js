import http from "http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import "./env.js";
import { ensureAuthSchema, verifyAuthToken } from "./auth.js";
import pool, { formatDbError, getDatabaseSummary, verifyDatabaseConnection } from "./db.js";
import { loadPlayers } from "./playerStore.js";
import { loadTeams } from "./teamStore.js";
import {
  createRoomSession,
  ensureRoomSessionSchema,
  getLatestRoomSession,
} from "./roomSessions.js";
import { rooms, PUBLIC_ROOMS_CHANNEL } from "./runtimeRooms.js";
import apiRouter from "./routes.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use(apiRouter);

app.get("/teams", async (_req, res) => {
  const teams = await loadTeams();
  res.json(teams);
});

const server = http.createServer(app);

// Flexible CORS for Render/Production
const allowedOrigins = ["http://localhost:5173", process.env.FRONTEND_ORIGIN].filter(Boolean);
console.log("Allowed CORS Origins:", allowedOrigins.length ? allowedOrigins : "ALL (*)");

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : true,
    methods: ["GET", "POST"],
  },
});

let playersMaster = [];
let teamsMaster = [];

function shuffle(array) {
  return array
    .map((item) => ({ ...item, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ sort, ...rest }) => rest);
}

function organizePlayersIntoSets(players) {
  const isIndian = (p) => (p.country || "").toLowerCase() === "india";
  const getRole = (p) => (p.role || "").toLowerCase();

  const isWk = (p) => getRole(p).includes("keep") || getRole(p).includes("wk");
  const isAr = (p) => getRole(p).includes("all");
  const isBat = (p) => getRole(p).includes("bat") || getRole(p).includes("open") || getRole(p).includes("middle");
  const isBowl = (p) => getRole(p).includes("bowl") || getRole(p).includes("pace") || getRole(p).includes("spin");

  const categories = [
    { name: "Indian Batsmen", filter: (p) => isIndian(p) && isBat(p) && !isAr(p) && !isWk(p) },
    { name: "Overseas Batsmen", filter: (p) => !isIndian(p) && isBat(p) && !isAr(p) && !isWk(p) },
    { name: "Indian All-Rounders", filter: (p) => isIndian(p) && isAr(p) },
    { name: "Overseas All-Rounders", filter: (p) => !isIndian(p) && isAr(p) },
    { name: "Indian Bowlers", filter: (p) => isIndian(p) && isBowl(p) && !isAr(p) },
    { name: "Overseas Bowlers", filter: (p) => !isIndian(p) && isBowl(p) && !isAr(p) },
    { name: "Indian Wicketkeepers", filter: (p) => isIndian(p) && isWk(p) },
    { name: "Overseas Wicketkeepers", filter: (p) => !isIndian(p) && isWk(p) },
  ];

  let orderedQueue = [];
  const processedIds = new Set();

  categories.forEach((cat) => {
    const setPlayers = players.filter(cat.filter).filter((p) => !processedIds.has(p.id));
    // Shuffle within the set
    const shuffledSet = shuffle(setPlayers).map((p) => ({ ...p, setName: cat.name }));
    orderedQueue = [...orderedQueue, ...shuffledSet];
    setPlayers.forEach((p) => processedIds.add(p.id));
  });

  // Add any remaining players who didn't fit
  const remaining = players.filter((p) => !processedIds.has(p.id));
  if (remaining.length > 0) {
    orderedQueue = [...orderedQueue, ...shuffle(remaining).map((p) => ({ ...p, setName: "Other Players" }))];
  }

  return orderedQueue;
}

function createRoom(roomId) {
  const queuedPlayers = organizePlayersIntoSets(playersMaster);
  return {
    roomId,
    dbId: null,
    sessionNumber: 1,
    visibility: "private",
    creatorUserId: null,
    creatorName: null,
    creatorTeamName: null,
    createdAt: Date.now(),
    playersQueue: queuedPlayers,
    idx: 0,
    users: new Map(),
    voiceUsers: new Set(),
    currentPlayer: null,
    currentBid: 0,
    highestBidder: null,
    highestBidderUserId: null,
    highestBidderName: null,
    timer: null,
    timeLeft: 0,
    status: "waiting",
    lastBidAt: Date.now(),
    lastActivityAt: Date.now(),
    warnedOnce: false,
    warnedTwice: false,
    totalDuration: 13000,
    bidHistory: [],
    passedUsers: new Set(),
    skipPoolUsers: new Set(),
    blockedUsers: new Set(),
    withdrawnUsers: new Set(),
    playing11: new Map(),
    disqualified: new Set(),
    voiceUsers: new Set(),
    finalizingBid: false,
    disconnectTimeouts: new Map(), // socketId -> timeout
    closeTimeout: null,
    phaseStartedAt: Date.now(),
    restoredFromDb: false,
  };
}

function activeSockets(room) {
  const connectedSockets = io.sockets.adapter.rooms.get(room.roomId);
  return Array.from(room.users.keys()).filter((id) =>
    !room.blockedUsers.has(id) && connectedSockets?.has(id)
  );
}

function getEligiblePlaying11Participants(room) {
  return Array.from(room.users.entries())
    .filter(([socketId, user]) => !room.disqualified.has(socketId) && Array.isArray(user?.team))
    .map(([socketId]) => socketId);
}

function setRoomStatus(room, status) {
  if (!room) return;
  room.status = status;
  room.phaseStartedAt = Date.now();
}

function getTimerSnapshot(room) {
  if (!room || room.status !== "running" || !room.currentPlayer) return null;

  const totalMs = Number(room.totalDuration || 13000);
  const referenceTime = Number(room.lastBidAt || Date.now());
  const remainingMs = Math.max(0, totalMs - (Date.now() - referenceTime));

  return {
    remainingMs,
    totalMs,
    percent: totalMs > 0 ? (remainingMs / totalMs) * 100 : 0,
  };
}

function emitTimerTick(roomId, room) {
  const snapshot = getTimerSnapshot(room);
  if (!snapshot) return null;
  io.to(roomId).emit("timer_tick", snapshot);
  return snapshot;
}

function syncRoomMetadata(room, metadata = {}) {
  if (metadata.dbId && !room.dbId) {
    room.dbId = metadata.dbId;
  }
  if (metadata.sessionNumber) {
    room.sessionNumber = Number(metadata.sessionNumber) || room.sessionNumber || 1;
  }
  if (metadata.visibility) {
    room.visibility = metadata.visibility === "public" ? "public" : "private";
  }
  if (metadata.creatorUserId && !room.creatorUserId) {
    room.creatorUserId = metadata.creatorUserId;
  }
  if (metadata.creatorName) {
    room.creatorName = metadata.creatorName;
  }
  if (metadata.creatorTeamName) {
    room.creatorTeamName = metadata.creatorTeamName;
  }
  if (metadata.createdAt && !room.createdAt) {
    room.createdAt = metadata.createdAt;
  }
}

function getRoom(roomId, dbId = null, metadata = {}) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, createRoom(roomId));
  }
  const room = rooms.get(roomId);
  syncRoomMetadata(room, { dbId, ...metadata });
  return room;
}

function replaceRoom(roomId, dbId = null, metadata = {}) {
  const existingRoom = rooms.get(roomId);
  if (existingRoom?.timer) {
    clearInterval(existingRoom.timer);
  }
  if (existingRoom?.closeTimeout) {
    clearTimeout(existingRoom.closeTimeout);
  }

  const nextRoom = createRoom(roomId);
  syncRoomMetadata(nextRoom, { dbId, ...metadata });
  rooms.set(roomId, nextRoom);
  return nextRoom;
}

function isTerminalRoomStatus(status) {
  return status === "picking" || status === "finished_finalized";
}

function getRoomForSession(roomId, dbId = null, metadata = {}) {
  const existingRoom = rooms.get(roomId);
  const hasDifferentSession =
    Boolean(existingRoom?.dbId) && Boolean(dbId) && Number(existingRoom.dbId) !== Number(dbId);
  const canReplaceExistingRoom =
    isTerminalRoomStatus(existingRoom?.status) ||
    (existingRoom?.status === "waiting" && existingRoom.users.size === 0);

  if (hasDifferentSession && canReplaceExistingRoom) {
    return replaceRoom(roomId, dbId, metadata);
  }

  return getRoom(roomId, dbId, metadata);
}

function getActiveLobbyParticipants(room) {
  return activeSockets(room).map((socketId) => room.users.get(socketId)).filter(Boolean);
}

function getPublicRoomsSnapshot() {
  return Array.from(rooms.values())
    .filter((room) => room.visibility === "public" && room.status === "waiting")
    .map((room) => {
      const participants = getActiveLobbyParticipants(room);
      if (participants.length === 0) return null;

      return {
        roomId: room.roomId,
        visibility: room.visibility,
        participantCount: participants.length,
        creatorName: room.creatorName || participants.find((entry) => entry.userId === room.creatorUserId)?.username || "Host",
        creatorTeamName: room.creatorTeamName || participants.find((entry) => entry.userId === room.creatorUserId)?.teamName || null,
        createdAt: room.createdAt || Date.now(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function broadcastPublicRooms() {
  io.to(PUBLIC_ROOMS_CHANNEL).emit("public_rooms_update", getPublicRoomsSnapshot());
}

function touchRoomActivity(room) {
  if (!room) return;
  room.lastActivityAt = Date.now();
}

async function closeRoomNow(roomId, reason, code = "ROOM_CLOSED") {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.timer) {
    clearInterval(room.timer);
  }
  if (room.closeTimeout) {
    clearTimeout(room.closeTimeout);
  }

  if (room.dbId) {
    await pool
      .query("UPDATE rooms SET status = 'finished' WHERE id = ?", [room.dbId])
      .catch((err) => console.error("Failed to mark room finished during close", err.message));
    await clearAuctionState(room.dbId);
  }

  io.to(roomId).emit("room_closed", { code, reason });
  io.in(roomId).socketsLeave(roomId);
  rooms.delete(roomId);
  broadcastPublicRooms();
}

function scheduleFinishedRoomClosure(roomId, sessionDbId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.closeTimeout) {
    clearTimeout(room.closeTimeout);
  }

  const now = Date.now();
  const deadlineMs = Number(room.selectDeadline || 0);
  const msUntilDeadline = deadlineMs > now ? deadlineMs - now : 0;
  const closeDelayMs = Math.max(1000, msUntilDeadline + 1000);

  room.closeTimeout = setTimeout(() => {
    const latestRoom = rooms.get(roomId);
    if (!latestRoom) return;
    if (latestRoom.status !== "finished_finalized") return;
    if (sessionDbId && latestRoom.dbId && Number(latestRoom.dbId) !== Number(sessionDbId)) return;
    closeRoomNow(roomId, "This auction has ended and the room is now closed.", "RESULT_TIMER_ENDED");
  }, closeDelayMs);
}

function calculateScore(team = []) {
  return team.reduce((sum, player) => sum + Number(player.rating || 0), 0);
}

function getQueueState(room) {
  return {
    remaining: room.playersQueue.length - room.idx,
    completed: Math.max(0, room.idx - (room.currentPlayer ? 1 : 0)),
    total: room.playersQueue.length,
    currentIndex: room.idx,
    currentSetName: room.currentPlayer?.setName || null,
  };
}

function getHighestBidderName(room) {
  const user = room.users.get(room.highestBidder || "");
  return user?.teamName || user?.username || room.highestBidderName || null;
}

function getHighestBidderEntry(room) {
  if (room.highestBidder && room.users.has(room.highestBidder)) {
    return [room.highestBidder, room.users.get(room.highestBidder)];
  }

  if (!room.highestBidderUserId) return [null, null];

  for (const [socketId, user] of room.users.entries()) {
    if (user.userId && user.userId === room.highestBidderUserId) {
      return [socketId, user];
    }
  }

  return [null, null];
}

function findRoomUser(room, userId, username) {
  for (const [socketId, user] of room.users.entries()) {
    if (userId && user.userId && user.userId === userId) {
      return [socketId, user];
    }
    if (username && user.username === username) {
      return [socketId, user];
    }
  }

  return [null, null];
}

function moveSetMembership(set, from, to) {
  if (from && from !== to && set.has(from)) {
    set.delete(from);
    set.add(to);
  }
}

function moveMapMembership(map, from, to) {
  if (from && from !== to && map.has(from)) {
    const value = map.get(from);
    map.delete(from);
    map.set(to, value);
  }
}

function migrateSocketIdentity(room, previousSocketId, nextSocketId) {
  if (!previousSocketId || previousSocketId === nextSocketId || !room.users.has(previousSocketId)) {
    return;
  }

  const existingUser = room.users.get(previousSocketId);
  room.users.delete(previousSocketId);
  room.users.set(nextSocketId, existingUser);

  if (room.highestBidder === previousSocketId) {
    room.highestBidder = nextSocketId;
  }

  moveSetMembership(room.passedUsers, previousSocketId, nextSocketId);
  moveSetMembership(room.blockedUsers, previousSocketId, nextSocketId);
  moveSetMembership(room.withdrawnUsers, previousSocketId, nextSocketId);
  moveSetMembership(room.disqualified, previousSocketId, nextSocketId);
  moveMapMembership(room.playing11, previousSocketId, nextSocketId);
}

function getPersistentUserKey(userId) {
  const numericUserId = Number(userId);
  if (!Number.isInteger(numericUserId) || numericUserId <= 0) return null;
  return `user:${numericUserId}`;
}

function getRuntimeEntryUserId(room, runtimeKey) {
  const numericUserId = Number(room?.users?.get(runtimeKey)?.userId || 0);
  return Number.isInteger(numericUserId) && numericUserId > 0 ? numericUserId : null;
}

function serializeRuntimeUserIds(room, collection) {
  const uniqueUserIds = new Set();
  for (const runtimeKey of collection || []) {
    const userId = getRuntimeEntryUserId(room, runtimeKey);
    if (userId) {
      uniqueUserIds.add(userId);
    }
  }
  return Array.from(uniqueUserIds);
}

function serializePlaying11Entries(room) {
  const entries = [];
  for (const [runtimeKey, entry] of room.playing11.entries()) {
    const userId = getRuntimeEntryUserId(room, runtimeKey);
    if (!userId) continue;

    entries.push({
      userId,
      score: Number(entry?.score || 0),
      playerIds: Array.isArray(entry?.playerIds) ? entry.playerIds.map(Number) : [],
      playerNames: Array.isArray(entry?.playerNames) ? entry.playerNames : [],
      username: entry?.username || room.users.get(runtimeKey)?.username || null,
      teamName: entry?.teamName || room.users.get(runtimeKey)?.teamName || null,
      breakdown: entry?.breakdown || null,
    });
  }
  return entries;
}

function normalizePlayerIdList(lineup) {
  if (!Array.isArray(lineup)) return [];
  return lineup
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function getPlayerNameById(playerId) {
  return playersMaster.find((player) => Number(player.id) === Number(playerId))?.name || null;
}

async function clearAuctionState(roomDbId) {
  const numericRoomDbId = Number(roomDbId);
  if (!Number.isInteger(numericRoomDbId) || numericRoomDbId <= 0) return;

  await pool
    .query("DELETE FROM auction_state WHERE room_id = ?", [numericRoomDbId])
    .catch((err) => console.error("Failed to clear auction state", formatDbError(err)));
}

async function loadStoredAuctionState(roomDbId) {
  const numericRoomDbId = Number(roomDbId);
  if (!Number.isInteger(numericRoomDbId) || numericRoomDbId <= 0) return null;

  const [stateRows] = await pool.query(
    "SELECT state FROM auction_state WHERE room_id = ? LIMIT 1",
    [numericRoomDbId]
  );

  return stateRows[0]?.state || null;
}

function isRecoverableStoredState(state) {
  const status = String(state?.status || "").trim();
  return ["starting", "transitioning", "running", "sold", "picking", "finished_finalized"].includes(status);
}

async function loadPersistedRoomUsers(roomDbId) {
  const [participants] = await pool.query(
    `SELECT rp.user_id AS "userId", u.username, rp.budget, rp.team_name AS "teamName"
     FROM room_players rp
     JOIN users u ON u.id = rp.user_id
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

async function loadPersistedPlaying11Entries(roomDbId) {
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

async function restoreRoomFromDatabase(roomId, roomDbId, metadata = {}, preloadedState = null) {
  const room = getRoomForSession(roomId, roomDbId, metadata);
  if (room.restoredFromDb) {
    return room;
  }

  let recovered = preloadedState;
  if (!recovered && roomDbId) {
    try {
      recovered = await loadStoredAuctionState(roomDbId);
    } catch (err) {
      console.error("State recovery failed", formatDbError(err));
      return room;
    }
  }

  if (!isRecoverableStoredState(recovered)) {
    return room;
  }

  room.restoredFromDb = true;

  try {
    const persistedUsers = roomDbId ? await loadPersistedRoomUsers(roomDbId) : [];
    const persistedUserMap = new Map();

    room.users = new Map();
    for (const persistedUser of persistedUsers) {
      const runtimeKey = getPersistentUserKey(persistedUser.userId);
      if (!runtimeKey) continue;
      room.users.set(runtimeKey, persistedUser);
      persistedUserMap.set(Number(persistedUser.userId), runtimeKey);
    }

    room.playersQueue =
      Array.isArray(recovered?.playersQueue) && recovered.playersQueue.length
        ? recovered.playersQueue
        : organizePlayersIntoSets(playersMaster);
    room.idx = Number(recovered?.idx || 0);
    room.status = recovered?.status || room.status;
    room.phaseStartedAt = Number(recovered?.phaseStartedAt || Date.now());
    room.currentPlayer =
      recovered?.currentPlayer ||
      (room.idx > 0 && room.idx <= room.playersQueue.length ? room.playersQueue[room.idx - 1] : null);
    room.currentBid = Number(recovered?.currentBid || 0);
    room.highestBidderUserId = Number(recovered?.highestBidderUserId || 0) || null;
    room.highestBidderName = recovered?.highestBidderName || null;
    room.highestBidder = room.highestBidderUserId
      ? persistedUserMap.get(Number(room.highestBidderUserId)) || null
      : null;
    room.lastBidAt = Number(recovered?.lastBidAt || Date.now());
    room.lastActivityAt = Number(recovered?.lastActivityAt || room.lastBidAt || Date.now());
    room.totalDuration = Number(recovered?.totalDuration || 13000);
    room.warnedOnce = Boolean(recovered?.warnedOnce);
    room.warnedTwice = Boolean(recovered?.warnedTwice);
    room.bidHistory = Array.isArray(recovered?.bidHistory) ? recovered.bidHistory : [];
    room.selectionStartTime = recovered?.selectionStartTime || null;
    room.selectDeadline = recovered?.selectDeadline || null;
    room.finalizingBid = false;

    const toRuntimeSet = (userIds) =>
      new Set(
        (Array.isArray(userIds) ? userIds : [])
          .map((userId) => persistedUserMap.get(Number(userId)))
          .filter(Boolean)
      );

    room.passedUsers = toRuntimeSet(recovered?.passedUserIds);
    room.skipPoolUsers = toRuntimeSet(recovered?.skipPoolUserIds);
    room.blockedUsers = toRuntimeSet(recovered?.blockedUserIds);
    room.withdrawnUsers = toRuntimeSet(recovered?.withdrawnUserIds);
    room.disqualified = toRuntimeSet(recovered?.disqualifiedUserIds);

    const playing11Entries =
      Array.isArray(recovered?.playing11) && recovered.playing11.length
        ? recovered.playing11
        : roomDbId
          ? await loadPersistedPlaying11Entries(roomDbId)
          : [];
    room.playing11 = new Map();
    for (const entry of playing11Entries) {
      const runtimeKey = persistedUserMap.get(Number(entry?.userId));
      if (!runtimeKey) continue;

      const roomUser = room.users.get(runtimeKey);
      const playerIds = normalizePlayerIdList(entry?.playerIds);
      const playerNames =
        Array.isArray(entry?.playerNames) && entry.playerNames.length
          ? entry.playerNames
          : playerIds
              .map((playerId) => roomUser?.team.find((player) => Number(player.id) === Number(playerId))?.name || getPlayerNameById(playerId))
              .filter(Boolean);

      room.playing11.set(runtimeKey, {
        score: Number(entry?.score || 0),
        playerIds,
        playerNames,
        username: entry?.username || roomUser?.username || null,
        teamName: entry?.teamName || roomUser?.teamName || null,
        breakdown: entry?.breakdown || null,
      });
    }

    if (room.status === "running") {
      const storedRemainingMs = Number(recovered?.remainingMs || 0);
      if (storedRemainingMs > 0) {
        room.totalDuration = storedRemainingMs;
        room.lastBidAt = Date.now();
        room.warnedOnce = false;
        room.warnedTwice = false;
      }
    }

    if (room.status === "finished_finalized") {
      scheduleFinishedRoomClosure(roomId, room.dbId);
    }

    console.log(`Recovered persisted live state for room ${roomId}:`, {
      status: room.status,
      idx: room.idx,
      participants: room.users.size,
      currentPlayer: room.currentPlayer?.name || null,
    });
  } catch (err) {
    console.error("Failed to restore room from database", formatDbError(err));
  }

  return room;
}

async function finishPersistedRoomSession(roomDbId) {
  const numericRoomDbId = Number(roomDbId);
  if (!Number.isInteger(numericRoomDbId) || numericRoomDbId <= 0) return;

  await pool
    .query("UPDATE rooms SET status = 'finished' WHERE id = ?", [numericRoomDbId])
    .catch((err) => console.error("Failed to mark persisted room finished", formatDbError(err)));
  await clearAuctionState(numericRoomDbId);
}

async function loadUnfinishedRoomSnapshots() {
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

async function reconcilePersistedLiveRooms() {
  const now = Date.now();
  const snapshots = await loadUnfinishedRoomSnapshots();

  for (const snapshot of snapshots) {
    const roomId = String(snapshot.roomCode || "").trim();
    if (!roomId) continue;

    const runtimeRoom = rooms.get(roomId);
    if (runtimeRoom && Number(runtimeRoom.dbId || 0) === Number(snapshot.id || 0)) {
      continue;
    }

    const recoveredState = snapshot.state || null;
    const effectiveStatus =
      String(recoveredState?.status || (snapshot.status === "ongoing" ? "running" : snapshot.status || "waiting")).trim();
    const createdAtMs = snapshot.createdAt ? new Date(snapshot.createdAt).getTime() : now;
    const lastTouchMs = Number(recoveredState?.lastActivityAt || recoveredState?.lastBidAt || createdAtMs || now);
    const selectDeadlineMs = Number(recoveredState?.selectDeadline || 0);
    const isStale = now - lastTouchMs > INACTIVE_AUCTION_ROOM_RETENTION_MS;
    const canRecoverFromState = isRecoverableStoredState(recoveredState);

    if (effectiveStatus === "picking" && selectDeadlineMs > 0 && now >= selectDeadlineMs && canRecoverFromState) {
      const restoredRoom = await restoreRoomFromDatabase(
        roomId,
        snapshot.id,
        {
          sessionNumber: snapshot.sessionNumber,
          creatorUserId: snapshot.hostId,
          createdAt: createdAtMs,
        },
        recoveredState
      );
      await autoFinalizePlaying11(restoredRoom.roomId);
      continue;
    }

    if (effectiveStatus === "finished_finalized" && canRecoverFromState) {
      const restoredRoom = await restoreRoomFromDatabase(
        roomId,
        snapshot.id,
        {
          sessionNumber: snapshot.sessionNumber,
          creatorUserId: snapshot.hostId,
          createdAt: createdAtMs,
        },
        recoveredState
      );

      if (selectDeadlineMs > 0 && now >= selectDeadlineMs + 1000) {
        await closeRoomNow(restoredRoom.roomId, "This auction has ended and the room is now closed.", "RESULT_TIMER_ENDED");
      } else {
        scheduleFinishedRoomClosure(restoredRoom.roomId, restoredRoom.dbId);
      }
      continue;
    }

    if (["starting", "transitioning", "running", "sold", "picking"].includes(effectiveStatus) && !isStale && canRecoverFromState) {
      await restoreRoomFromDatabase(
        roomId,
        snapshot.id,
        {
          sessionNumber: snapshot.sessionNumber,
          creatorUserId: snapshot.hostId,
          createdAt: createdAtMs,
        },
        recoveredState
      );
      continue;
    }

    await finishPersistedRoomSession(snapshot.id);
  }
}

async function ensureRoomPlayerRow(roomDbId, userId, teamName, teamId) {
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
    duplicateCount: 0,
  };
}

async function persistPlaying11(roomDbId, userId, lineup, score) {
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

async function getRoomPursesSnapshot(roomDbId) {
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
    [roomDbId, roomDbId]
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
    [roomDbId, roomDbId]
  );

  const playersByUser = new Map();
  for (const player of purchasedPlayers) {
    const existing = playersByUser.get(player.userId) || [];
    existing.push(player);
    playersByUser.set(player.userId, existing);
  }

  return purses.map((entry) => ({
    ...entry,
    players: playersByUser.get(entry.userId) || [],
  }));
}

function broadcastPlayers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  // Filter out spectators (blocked users) from the public franchise list
  const players = Array.from(room.users.entries())
    .filter(([socketId]) => !room.blockedUsers.has(socketId))
    .map(([, u]) => ({
      username: u.username,
      team: u.teamName || null,
      isCreator: Boolean(room.creatorUserId && u.userId === room.creatorUserId),
    }));

  io.to(roomId).emit("players_update", players);
  broadcastPublicRooms();
}

function startTimer(roomId, { preserveElapsed = false } = {}) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (!preserveElapsed || !room.lastBidAt) {
    room.lastBidAt = Date.now();
    room.warnedOnce = false;
    room.warnedTwice = false;
  }

  if (room.timer) clearInterval(room.timer);
  emitTimerTick(roomId, room);
  room.timer = setInterval(async () => {
    const activeIds = activeSockets(room);
    if (activeIds.length === 0) {
      // Pause timer by shifting lastBidAt forward
      room.lastBidAt += 1000;
      return;
    }

    const totalDuration = room.totalDuration || 13000;
    const idleMs = Date.now() - (room.lastBidAt || 0);
    const snapshot = emitTimerTick(roomId, room);
    const remainingMs = snapshot?.remainingMs ?? Math.max(0, totalDuration - idleMs);

    if (!room.warnedOnce && remainingMs <= 5000) {
      room.warnedOnce = true;
      io.to(roomId).emit("bid_warning", { stage: "once", by: getHighestBidderName(room) || "No bids" });
    } else if (room.warnedOnce && !room.warnedTwice && remainingMs <= 2000) {
      room.warnedTwice = true;
      io.to(roomId).emit("bid_warning", { stage: "twice", by: getHighestBidderName(room) || "No bids" });
    } else if (idleMs >= totalDuration) {
      clearInterval(room.timer);
      room.timer = null;
      await finalizeBid(roomId);
      return;
    }
  }, 1000);
}

function maybeAutoResolve(roomId, isManualAction = false) {
  const room = rooms.get(roomId);
  if (!room || !room.currentPlayer || room.status !== "running") return;

  // SAFETY LOCK: Don't auto-resolve within the first 5 seconds UNLESS it was a manual button press.
  // This prevents "sudden skipping" on player load while keeping buttons responsive.
  const timeSinceStart = Date.now() - (room.lastBidAt || 0);
  if (!isManualAction && timeSinceStart < 5000) return;

  const activeIds = activeSockets(room);
  if (activeIds.length === 0) return;

  // If every active player has either passed, voted to skip the pool, or is the high bidder,
  // then no more bidding is possible. Finalize immediately.
  const noMoreBidsPossible = activeIds.every(id =>
    id === room.highestBidder || room.passedUsers.has(id) || room.skipPoolUsers.has(id)
  );

  if (noMoreBidsPossible) {
    if (room.timer) {
      clearInterval(room.timer);
      room.timer = null;
    }
    finalizeBid(roomId);
  }
}

function emitQueueUpdate(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit("queue_update", getQueueState(room));
}

function evaluatePlaying11(room, socketId, playerIds) {
  const user = room.users.get(socketId);
  if (!user) return { ok: false, reason: "user missing" };
  if (playerIds.length !== 11) return { ok: false, reason: "Must pick exactly 11 players" };

  const owned = new Map(user.team.map((p) => [p.id, p]));
  const lineup = [];
  for (const id of playerIds) {
    if (!owned.has(id)) return { ok: false, reason: "Contains player you do not own" };
    lineup.push(owned.get(id));
  }

  let bats = 0, bowls = 0, wks = 0, ars = 0, overseas = 0;
  let battingTotal = 0, bowlingTotal = 0;
  lineup.forEach((p) => {
    const role = (p.role || "").toLowerCase();
    const batR = Number(p.batting_rating ?? p.rating ?? 0);
    const bowlR = Number(p.bowling_rating ?? p.rating ?? 0);
    const isOverseas = (p.country || "").toLowerCase() !== "india";
    if (isOverseas) overseas += 1;

    const isAr = role.includes("all");
    const isBat = role.includes("bat") || role.includes("open") || role.includes("middle");
    const isBowl = role.includes("bowl") || role.includes("pace") || role.includes("spin");
    const isWk = role.includes("keep") || role.includes("wk");

    if (isAr) {
      ars += 1;
      // All-rounder counts as AR only (not in Bat/Bowl categories for rule validation)
      battingTotal += batR;
      bowlingTotal += bowlR;
    } else {
      if (isBat) { bats += 1; battingTotal += batR; }
      if (isBowl) { bowls += 1; bowlingTotal += bowlR; }
      if (isWk) { wks += 1; bats += 1; battingTotal += batR; }
    }
  });

  if (bats < 3) return { ok: false, reason: "Need at least 3 batsmen" };
  if (bowls < 2) return { ok: false, reason: "Need at least 2 bowlers" };
  if (wks < 1) return { ok: false, reason: "Need at least 1 wicketkeeper" };
  if (ars > 4) return { ok: false, reason: "Max 4 all-rounders" };
  if (overseas > 4) return { ok: false, reason: "Max 4 overseas players" };

  const balanceBonus = Number(user.budget || 0);
  const score = (battingTotal + bowlingTotal) * 0.4 + balanceBonus * 0.2;

  return {
    ok: true,
    score,
    breakdown: { battingTotal, bowlingTotal, balanceBonus, bats, bowls, wks, ars },
    playerNames: lineup.map((p) => p.name),
  };
}

async function persistAuctionState(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.dbId) return;

  const timerSnapshot = getTimerSnapshot(room);

  const state = {
    idx: room.idx,
    status: room.status,
    phaseStartedAt: room.phaseStartedAt,
    currentBid: room.currentBid,
    currentPlayer: room.currentPlayer,
    highestBidderUserId: room.highestBidderUserId,
    highestBidderName: room.highestBidderName,
    lastBidAt: room.lastBidAt,
    lastActivityAt: room.lastActivityAt,
    totalDuration: room.totalDuration,
    remainingMs: timerSnapshot?.remainingMs ?? null,
    warnedOnce: room.warnedOnce,
    warnedTwice: room.warnedTwice,
    playersQueue: room.playersQueue,
    bidHistory: room.bidHistory || [],
    passedUserIds: serializeRuntimeUserIds(room, room.passedUsers),
    skipPoolUserIds: serializeRuntimeUserIds(room, room.skipPoolUsers),
    blockedUserIds: serializeRuntimeUserIds(room, room.blockedUsers),
    withdrawnUserIds: serializeRuntimeUserIds(room, room.withdrawnUsers),
    disqualifiedUserIds: serializeRuntimeUserIds(room, room.disqualified),
    playing11: serializePlaying11Entries(room),
    selectionStartTime: room.selectionStartTime,
    selectDeadline: room.selectDeadline,
  };

  try {
    const serialized = JSON.stringify(state);
    const [updateResult] = await pool.query(
      "UPDATE auction_state SET state = ?::jsonb WHERE room_id = ?",
      [serialized, room.dbId]
    );

    if (updateResult.rowCount === 0) {
      await pool.query(
        "INSERT INTO auction_state (room_id, state) VALUES (?, ?::jsonb)",
        [room.dbId, serialized]
      );
    }
  } catch (err) {
    console.error(`Failed to persist auction state for room ${roomId}`, err.message);
  }
}

async function startNextPlayer(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }

  // Set status to pending while finding next player
  setRoomStatus(room, "transitioning");
  broadcastPublicRooms();
  await persistAuctionState(roomId);

  // Find the next player in the queue who hasn't been sold or marked unsold
  let nextPlayer = null;
  while (room.idx < room.playersQueue.length) {
    const candidate = room.playersQueue[room.idx];
    room.idx += 1;

    if (room.dbId) {
      try {
        const [sold] = await pool.query(
          "SELECT id FROM team_players WHERE room_id = ? AND player_id = ? LIMIT 1",
          [room.dbId, candidate.id]
        );
        if (sold.length === 0) {
          nextPlayer = candidate;
          break;
        }
      } catch (err) {
        console.error("Error checking player status in startNextPlayer", err.message);
        nextPlayer = candidate; // Fallback
        break;
      }
    } else {
      nextPlayer = candidate;
      break;
    }
  }

  if (!nextPlayer) {
    endAuction(roomId);
    return;
  }

  const player = nextPlayer;
  const isNewSet = !room.currentPlayer || room.currentPlayer.setName !== player.setName;

  if (isNewSet) {
    io.to(roomId).emit("set_transition", { setName: player.setName });
    // Wait for the transition animation to play before showing the player
    setTimeout(async () => {
      room.currentPlayer = player;
      room.currentBid = Number(player.base_price || 0);
      room.highestBidder = null;
      room.highestBidderUserId = null;
      room.highestBidderName = null;
      setRoomStatus(room, "running");
      broadcastPublicRooms();
      room.totalDuration = 13000;
      room.lastBidAt = Date.now();
      room.warnedOnce = false;
      room.warnedTwice = false;
      room.passedUsers = new Set();
      room.bidHistory = [];

      if (room.dbId) {
        pool
          .query("UPDATE rooms SET status = 'ongoing' WHERE id = ?", [room.dbId])
          .catch((err) => console.error("Failed to mark room ongoing", err.message));
      }

      io.to(roomId).emit("new_player", player);
      io.to(roomId).emit("bid_update", { amount: room.currentBid, by: null, history: room.bidHistory || [] });

      // Reset skip votes only on a NEW set
      room.skipPoolUsers = new Set();
      io.to(roomId).emit("skip_update", {
        count: 0,
        total: activeSockets(room).length,
        setName: player.setName
      });

      emitQueueUpdate(roomId);
      startTimer(roomId);
      maybeAutoResolve(roomId, true);
      await persistAuctionState(roomId);
    }, 4000); // 4 second delay for the set transition animation
    return;
  }

  room.currentPlayer = player;
  room.currentBid = Number(player.base_price || 0);
  room.highestBidder = null;
  room.highestBidderUserId = null;
  room.highestBidderName = null;
  setRoomStatus(room, "running");
  broadcastPublicRooms();
  room.totalDuration = 13000;
  room.lastBidAt = Date.now();
  room.warnedOnce = false;
  room.warnedTwice = false;
  room.passedUsers = new Set();
  room.bidHistory = [];

  if (room.dbId) {
    pool
      .query("UPDATE rooms SET status = 'ongoing' WHERE id = ?", [room.dbId])
      .catch((err) => console.error("Failed to mark room ongoing", err.message));
  }

  io.to(roomId).emit("new_player", player);
  io.to(roomId).emit("bid_update", { amount: room.currentBid, by: null, history: room.bidHistory || [] });

  // Do NOT reset skipPoolUsers here if it's the same set
  io.to(roomId).emit("skip_update", {
    count: room.skipPoolUsers.size,
    total: activeSockets(room).length,
    setName: player.setName
  });

  emitQueueUpdate(roomId);
  startTimer(roomId);
  maybeAutoResolve(roomId, true);
  await persistAuctionState(roomId);
}

async function skipPool(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.currentPlayer) return;

  const currentSetName = room.currentPlayer.setName;
  console.log(`Skipping pool: ${currentSetName} in room ${roomId}`);

  // Mark current player as unsold
  if (room.dbId) {
    try {
      await pool.query(
        "INSERT INTO unsold_players (room_id, player_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
        [room.dbId, room.currentPlayer.id]
      );
    } catch (err) {
      console.error("Failed to record unsold player on skip", err.message);
    }
  }

  // Find the next pool (setName)
  let nextPoolIdx = room.idx;
  while (nextPoolIdx < room.playersQueue.length) {
    if (room.playersQueue[nextPoolIdx].setName !== currentSetName) {
      break;
    }
    const skippedPlayer = room.playersQueue[nextPoolIdx];
    // Record skipped players as unsold in DB
    if (room.dbId) {
      try {
        await pool.query(
          "INSERT INTO unsold_players (room_id, player_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
          [room.dbId, skippedPlayer.id]
        );
      } catch (err) {
        console.error("Failed to record skipped player as unsold", err.message);
      }
    }
    nextPoolIdx++;
  }

  room.idx = nextPoolIdx;
  room.skipPoolUsers = new Set();

  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }

  io.to(roomId).emit("chat_message", {
    user: "SYSTEM",
    text: `All players voted to skip the "${currentSetName}" pool. Advancing to the next set...`,
    ts: Date.now(),
  });

  startNextPlayer(roomId);
}

async function finalizeBid(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.currentPlayer || room.finalizingBid) return;

  room.finalizingBid = true;
  setRoomStatus(room, "sold");
  await persistAuctionState(roomId);
  const soldPlayer = { ...room.currentPlayer };
  const soldPrice = Number(room.currentBid || soldPlayer.base_price || 0);

  const [winnerSocketId, liveWinner] = getHighestBidderEntry(room);
  const winnerUserId = liveWinner?.userId || room.highestBidderUserId || null;
  const winnerName = getHighestBidderName(room);

  try {
    if (winnerUserId || liveWinner) {
      let currentBudget = Number(liveWinner?.budget ?? 120);

      // If we have a DB ID, always double check the budget from DB to be safe
      if (room.dbId && winnerUserId) {
        try {
          const [budgetRows] = await pool.query(
            "SELECT budget FROM room_players WHERE room_id = ? AND user_id = ? LIMIT 1",
            [room.dbId, winnerUserId]
          );
          if (budgetRows.length) {
            currentBudget = Number(budgetRows[0].budget);
          }
        } catch (err) {
          console.warn("Failed to fetch latest budget from DB in finalizeBid", err.message);
        }
      }

      let nextBudget = Math.max(0, currentBudget - soldPrice);
      let salePersisted = false;
      let saleAlreadyExists = false;

      if (liveWinner) {
        const alreadyOwned = liveWinner.team.some((player) => player.id === soldPlayer.id);
        if (!alreadyOwned) {
          liveWinner.team.push({ ...soldPlayer, price: soldPrice });
        }
        liveWinner.score = calculateScore(liveWinner.team);
      }

      if (room.dbId && winnerUserId) {
        try {
          const [existingSales] = await pool.query(
            "SELECT id, user_id, price FROM team_players WHERE room_id = ? AND player_id = ? ORDER BY id DESC LIMIT 1",
            [room.dbId, soldPlayer.id]
          );

          if (existingSales.length) {
            saleAlreadyExists = true;
            // If it already exists, we should use the budget that was ALREADY set
            // instead of subtracting again.
            const [budgetRows] = await pool.query(
              "SELECT budget FROM room_players WHERE room_id = ? AND user_id = ? LIMIT 1",
              [room.dbId, winnerUserId]
            );
            if (budgetRows.length) {
              nextBudget = Number(budgetRows[0].budget);
            }
          } else {
            // Persist the winning bid for record-keeping
            await pool.query(
              "INSERT INTO bids (room_id, player_id, user_id, bid_amount) VALUES (?, ?, ?, ?)",
              [room.dbId, soldPlayer.id, winnerUserId, soldPrice]
            ).catch(err => console.warn("Failed to log final winning bid", err.message));

            await pool.query(
              "INSERT INTO team_players (room_id, user_id, player_id, price) VALUES (?, ?, ?, ?)",
              [room.dbId, winnerUserId, soldPlayer.id, soldPrice]
            );
            await pool.query(
              "UPDATE room_players SET budget = ? WHERE room_id = ? AND user_id = ?",
              [nextBudget, room.dbId, winnerUserId]
            );
            salePersisted = true;
          }
        } catch (err) {
          console.error("Failed to persist team winner", formatDbError(err));
          room.finalizingBid = false;
          return;
        }
      }

      if (liveWinner) {
        liveWinner.budget = nextBudget;
      }
      if (winnerSocketId) {
        io.to(winnerSocketId).emit("budget_update", { budget: nextBudget });
      }

      io.to(roomId).emit("player_won", {
        player: { ...soldPlayer, price: soldPrice },
        winner: winnerName,
        winnerUserId,
        price: soldPrice,
        budget: nextBudget,
        duplicatedSaleIgnored: saleAlreadyExists && !salePersisted,
      });
    } else {
      // Record as unsold if it's a room with DB
      if (room.dbId) {
        try {
          await pool.query(
            "INSERT INTO unsold_players (room_id, player_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
            [room.dbId, soldPlayer.id]
          );
        } catch (err) {
          console.error("Failed to record unsold player", err.message);
        }
      }
      io.to(roomId).emit("player_won", {
        player: soldPlayer,
        winner: null,
      });

      // Only re-queue if no user manually interacted with the player (no bids, no manual passes, no skip votes)
      // This handles cases where the system might have skipped them incorrectly.
      const noUserInteraction = room.passedUsers.size === 0 && room.skipPoolUsers.size === 0 && room.bidHistory.length === 0;
      
      if (noUserInteraction) {
        console.log(`Sudden skip detected for ${soldPlayer.name}. Re-queueing in original set: ${soldPlayer.setName}`);
        // Insert back into the queue right after the current position to auction again soon
        // This keeps it in the same pool/set context
        room.playersQueue.splice(room.idx, 0, { ...soldPlayer });
      }
    }

    if (room.dbId) {
      try {
        const purses = await getRoomPursesSnapshot(room.dbId);
        io.to(roomId).emit("purses_update", {
          roomId,
          roomDbId: room.dbId,
          purses,
        });
      } catch (err) {
        console.error("Failed to broadcast purses", formatDbError(err));
      }
    }
  } finally {
    room.finalizingBid = false;

    // Check if the pool skip was unanimous
    const active = activeSockets(room);
    if (active.length > 0 && room.skipPoolUsers.size >= active.length) {
      setTimeout(() => {
        io.to(roomId).emit("pool_skipped", { setName: room.currentPlayer?.setName });
      }, 2000); // 2s delay to let sold/unsold animation finish
      setTimeout(() => skipPool(roomId), 3500);
    } else {
      setTimeout(() => startNextPlayer(roomId), 1500);
    }
  }
}

function endAuction(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.status === "picking" || room.status === "finished_finalized") return;
  setRoomStatus(room, "picking");
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }

  const scores = Array.from(room.users.entries()).map(([socketId, user]) => ({
    socketId,
    username: user.username,
    score: user.score || 0,
    players: user.team.length,
  }));
  io.to(roomId).emit("auction_complete", { stage: "select11", scores });

  if (room.dbId) {
    pool
      .query("UPDATE rooms SET status = 'finished' WHERE id = ?", [room.dbId])
      .catch((err) => console.error("Failed to mark room finished", err.message));
  }

  // determine eligibility
  const disqualified = new Set(room.disqualified);
  const userEntries = Array.from(room.users.entries());
  userEntries.forEach(([sid, user]) => {
    const roster = user.team || [];
    const total = roster.length;

    let bats = 0, bowls = 0, wks = 0, ars = 0, overseas = 0;
    roster.forEach((p) => {
      const role = (p.role || "").toLowerCase();
      const isAr = role.includes("all");
      const isBat = role.includes("bat") || role.includes("open") || role.includes("middle");
      const isBowl = role.includes("bowl") || role.includes("pace") || role.includes("spin");
      const isWk = role.includes("keep") || role.includes("wk");
      const isOs = (p.country || "").toLowerCase() !== "india";

      if (isOs) overseas += 1;
      if (isAr) {
        ars += 1;
      } else {
        if (isBat) bats += 1;
        if (isBowl) bowls += 1;
        if (isWk) { wks += 1; bats += 1; }
      }
    });

    const locals = total - overseas;

    const feasible =
      total >= 11 &&
      bats >= 3 &&
      bowls >= 2 &&
      wks >= 1 &&
      locals >= 7; // to satisfy max 4 overseas (total 11 - max 4 OS = min 7 locals)

    if (!feasible) disqualified.add(sid);
  });
  room.disqualified = disqualified;
  const dqNames = Array.from(disqualified).map((sid) => room.users.get(sid)?.username).filter(Boolean);

  room.selectionStartTime = Date.now();
  room.selectDeadline = Date.now() + 5 * 60 * 1000; // 5 minutes total
  persistAuctionState(roomId);
  setTimeout(() => autoFinalizePlaying11(roomId), 5 * 60 * 1000 + 500);

  io.to(roomId).emit("auction_complete", {
    stage: "select11",
    scores,
    disqualified: dqNames,
    deadline: room.selectDeadline,
    selectionStartTime: room.selectionStartTime,
  });
}

function buildAutoLineup(team) {
  const isOverseas = (p) => (p.country || "").toLowerCase() !== "india";

  const isValid = (lineup) => {
    if (lineup.length !== 11) return false;
    let bats = 0, bowls = 0, wks = 0, ars = 0, overseas = 0;
    lineup.forEach(p => {
      const role = (p.role || "").toLowerCase();
      const os = isOverseas(p);
      if (os) overseas++;
      const isAr = role.includes("all");
      const isBat = role.includes("bat") || role.includes("open") || role.includes("middle");
      const isBowl = role.includes("bowl") || role.includes("pace") || role.includes("spin");
      const isWk = role.includes("keep") || role.includes("wk");

      if (isAr) {
        ars++;
      } else {
        if (isBat) bats++;
        if (isBowl) bowls++;
        if (isWk) { wks++; bats++; }
      }
    });
    return bats >= 3 && bowls >= 2 && wks >= 1 && ars <= 4 && overseas <= 4;
  };

  const shuffleArray = (array) => {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  // Try many random combinations to find a valid one
  // This is more robust than greedy for meeting multiple constraints
  for (let i = 0; i < 1000; i++) {
    const shuffled = shuffleArray(team);
    const lineup = [];
    const ownedIds = new Set();

    // Fill to 11
    for (const p of shuffled) {
      if (lineup.length >= 11) break;
      if (!ownedIds.has(p.id)) {
        lineup.push(p);
        ownedIds.add(p.id);
      }
    }

    if (isValid(lineup)) return lineup;
  }

  return null;
}

async function autoFinalizePlaying11(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.status !== "picking") return;

  const allUserIds = Array.from(room.users.keys());
  const disqualified = room.disqualified || new Set();
  const persistJobs = [];

  for (const sid of allUserIds) {
    if (disqualified.has(sid)) continue;
    if (room.playing11.has(sid)) continue;

    const user = room.users.get(sid);
    if (!user || !user.team) continue;

    const lineup = buildAutoLineup(user.team);
    if (lineup) {
      const evalResult = evaluatePlaying11(room, sid, lineup.map((p) => p.id));
      if (evalResult.ok) {
        room.playing11.set(sid, { 
          ...evalResult, 
          playerIds: lineup.map((p) => p.id), 
          username: user.username, 
          teamName: user.teamName,
          playerNames: lineup.map(p => p.name)
        });
        if (room.dbId && user.userId) {
          persistJobs.push(
            persistPlaying11(room.dbId, user.userId, lineup.map((p) => p.id), evalResult.score)
              .catch((err) => console.error("Failed to persist playing11", formatDbError(err)))
          );
        }
      } else {
        disqualified.add(sid);
      }
    } else {
      disqualified.add(sid);
    }
  }

  if (persistJobs.length) {
    await Promise.allSettled(persistJobs);
  }

  room.disqualified = disqualified;
  setRoomStatus(room, "finished_finalized");
  await persistAuctionState(roomId);

  const results = Array.from(room.playing11.values()).sort((a, b) => b.score - a.score);
  const winnerName = results[0]?.teamName || results[0]?.username || "No winner";
  const dqNames = Array.from(disqualified).map((sid) => room.users.get(sid)?.teamName || room.users.get(sid)?.username).filter(Boolean);

  io.to(roomId).emit("playing11_results", { winner: winnerName, results, disqualified: dqNames });
  scheduleFinishedRoomClosure(roomId, room.dbId);
}




function handleBid(socket, amount) {
  const roomId = socket.data.roomId;
  const room = rooms.get(roomId);
  if (!room || !room.currentPlayer || room.status !== "running" || room.finalizingBid) return;
  if (room.blockedUsers.has(socket.id)) return;
  if (room.passedUsers.has(socket.id)) return;
  if (room.skipPoolUsers.has(socket.id)) return;
  if (room.highestBidder === socket.id) return; // prevent consecutive self-bids

  const numericBid = Math.round(Number(amount) * 100) / 100;
  const currentBidRounded = Math.round(room.currentBid * 100) / 100;
  const step = currentBidRounded < 10 ? 0.2 : 0.5;

  // If no one has bid yet, allow bidding the base price (room.currentBid)
  const minRequired = room.highestBidder ? (currentBidRounded + step) : currentBidRounded;

  if (Number.isNaN(numericBid) || numericBid < minRequired - 1e-9) return;

  const user = room.users.get(socket.id);
  if (user && numericBid > (user.budget ?? 120)) {
    socket.emit("bid_error", { reason: "Insufficient budget" });
    return;
  }

  const idleMs = Date.now() - (room.lastBidAt || 0);
  const remainingMs = Math.max(0, (room.totalDuration || 13000) - idleMs);

  // Add 5 seconds to the current remaining time
  // Cap at 15 seconds to prevent excessive timer growth
  const newRemainingMs = Math.min(15000, remainingMs + 5000);
  room.totalDuration = newRemainingMs;

  const bidderName = user?.teamName || socket.data.username;
  room.currentBid = numericBid;
  room.highestBidder = socket.id;
  room.highestBidderUserId = user?.userId || null;
  room.highestBidderName = bidderName;
  room.lastBidAt = Date.now();
  touchRoomActivity(room);
  room.warnedOnce = false;
  room.warnedTwice = false;
  room.passedUsers.delete(socket.id);
  room.bidHistory.push({
    amount: room.currentBid,
    by: bidderName,
    ts: Date.now(),
  });

  io.to(roomId).emit("bid_update", {
    amount: room.currentBid,
    by: bidderName,
    history: room.bidHistory.slice(-10),
    step: room.currentBid < 10 ? 0.2 : 0.5,
  });

  // Broadcast update to maintain 'total' sockets but keep the skip count
  io.to(roomId).emit("skip_update", {
    count: room.skipPoolUsers.size,
    total: activeSockets(room).length,
    setName: room.currentPlayer?.setName
  });

  maybeAutoResolve(roomId, true);
  persistAuctionState(roomId);
}

const EMPTY_ROOM_RETENTION_MS = 2 * 60 * 60 * 1000;
const INACTIVE_AUCTION_ROOM_RETENTION_MS = 30 * 60 * 1000;
const ROOM_CLEANUP_INTERVAL_MS = 60 * 1000;
const AUCTION_STALL_WATCHDOG_INTERVAL_MS = 5000;

function isAuctionFlowRoomStatus(status) {
  return ["starting", "transitioning", "running", "sold", "picking", "finished_finalized"].includes(status);
}

setInterval(async () => {
  const now = Date.now();

  for (const [roomId, room] of Array.from(rooms.entries())) {
    if (!room) continue;

    if (room.status === "running" && room.currentPlayer && !room.finalizingBid && !room.timer) {
      const active = activeSockets(room);
      if (active.length === 0) continue;

      const timerState = getTimerSnapshot(room);
      if (!timerState) continue;

      if (timerState.remainingMs <= 0) {
        console.warn(`Watchdog finalizing stalled running auction in room ${roomId}`);
        await finalizeBid(roomId);
      } else {
        console.warn(`Watchdog restarting missing timer in room ${roomId}`);
        startTimer(roomId, { preserveElapsed: true });
      }
      continue;
    }

    if (room.status === "sold" && !room.finalizingBid && now - Number(room.phaseStartedAt || now) > 10000) {
      console.warn(`Watchdog advancing stuck sold state in room ${roomId}`);
      startNextPlayer(roomId);
      continue;
    }

    if (room.status === "transitioning" && now - Number(room.phaseStartedAt || now) > 12000) {
      console.warn(`Watchdog advancing stuck transition in room ${roomId}`);
      startNextPlayer(roomId);
    }
  }
}, AUCTION_STALL_WATCHDOG_INTERVAL_MS);

// Room cleanup:
// 1. Empty rooms are purged after 2 hours.
// 2. Auction/result rooms with no activity for 30 minutes are force-closed.
setInterval(async () => {
  const now = Date.now();
  let removedRoom = false;
  const roomsToForceClose = [];

  for (const [roomId, room] of Array.from(rooms.entries())) {
    if (room.users.size === 0 && (now - room.lastBidAt > EMPTY_ROOM_RETENTION_MS)) {
      console.log(`Cleaning up inactive room: ${roomId}`);
      if (room.timer) clearInterval(room.timer);
      if (room.closeTimeout) clearTimeout(room.closeTimeout);
      if (room.dbId) {
        await pool
          .query("UPDATE rooms SET status = 'finished' WHERE id = ?", [room.dbId])
          .catch((err) => console.error("Failed to mark empty room finished during cleanup", formatDbError(err)));
        await clearAuctionState(room.dbId);
      }
      rooms.delete(roomId);
      removedRoom = true;
      continue;
    }

    if (
      isAuctionFlowRoomStatus(room.status) &&
      now - Number(room.lastActivityAt || room.lastBidAt || room.createdAt || now) > INACTIVE_AUCTION_ROOM_RETENTION_MS
    ) {
      roomsToForceClose.push(roomId);
    }
  }

  for (const roomId of roomsToForceClose) {
    console.log(`Force closing stale auction room: ${roomId}`);
    await closeRoomNow(
      roomId,
      "This auction room was closed after 30 minutes of inactivity.",
      "INACTIVITY_TIMEOUT"
    );
    removedRoom = true;
  }

  if (removedRoom) {
    broadcastPublicRooms();
  }
}, ROOM_CLEANUP_INTERVAL_MS);

io.on("connection", (socket) => {
  socket.on("watch_public_rooms", () => {
    socket.join(PUBLIC_ROOMS_CHANNEL);
    socket.emit("public_rooms_update", getPublicRoomsSnapshot());
  });

  socket.on("unwatch_public_rooms", () => {
    socket.leave(PUBLIC_ROOMS_CHANNEL);
  });

  socket.on("join_room", async ({ roomId, username, teamName, visibility, token }) => {
    if (!roomId) return;
    let authenticatedSession = null;
    if (token) {
      try {
        authenticatedSession = verifyAuthToken(token);
      } catch (_error) {
        socket.emit("join_error", {
          code: "AUTH_INVALID",
          reason: "Your login session expired. Please sign in again.",
        });
        return;
      }
    }

    let cleanName = authenticatedSession?.username || (username || "").trim() || `Player-${socket.id.slice(-4)}`;
    let cleanTeam = (teamName || "").trim() || null;
    const requestedVisibility =
      visibility === "public" ? "public" : visibility === "private" ? "private" : null;
    socket.data.roomId = roomId;
    socket.data.username = cleanName;

    let userId = authenticatedSession?.userId || null;
    let roomDbId = null;
    let roomCreatorUserId = null;
    let roomCreatedAt = null;
    let roomSessionNumber = 1;
    let budget = 120;
    let teamId = null;
    let persistedTeam = [];
    let room = null;
    let existingSocketId = null;
    let existingUser = null;
    let latestStoredState = null;
    try {
      if (authenticatedSession?.userId) {
        const [users] = await pool.query(
          "SELECT id, username FROM users WHERE id = ? LIMIT 1",
          [authenticatedSession.userId]
        );
        if (!users.length) {
          socket.emit("join_error", {
            code: "AUTH_INVALID",
            reason: "Your login session is no longer valid. Please sign in again.",
          });
          return;
        }
        userId = users[0].id;
        cleanName = users[0].username;
      } else {
        const [users] = await pool.query("SELECT id FROM users WHERE username = ? LIMIT 1", [cleanName]);
        if (users.length) {
          userId = users[0].id;
        } else {
          const [insert] = await pool.query("INSERT INTO users (username) VALUES (?) RETURNING id", [cleanName]);
          userId = insert.insertId;
        }
      }

      socket.data.username = cleanName;

      let latestSession = await getLatestRoomSession(pool, roomId);
      latestStoredState = latestSession?.id ? await loadStoredAuctionState(latestSession.id).catch(() => null) : null;
      const liveRuntimeRoom = rooms.get(roomId);
      const shouldReuseFinishedLiveSession =
        latestSession?.status === "finished" &&
        liveRuntimeRoom &&
        Number(liveRuntimeRoom.dbId || 0) === Number(latestSession.id || 0) &&
        ["picking", "finished_finalized"].includes(liveRuntimeRoom.status);
      const shouldReuseFinishedStoredSession =
        latestSession?.status === "finished" &&
        isRecoverableStoredState(latestStoredState);

      if (
        !latestSession ||
        (latestSession.status === "finished" &&
          !shouldReuseFinishedLiveSession &&
          !shouldReuseFinishedStoredSession)
      ) {
        if (!authenticatedSession?.userId) {
          socket.emit("join_error", {
            code: "AUTH_REQUIRED_CREATE",
            reason: "Please log in or register before creating a new room.",
          });
          return;
        }

        latestSession = await createRoomSession(pool, roomId, userId);
      }

      roomDbId = Number(latestSession?.id || 0) || null;
      roomCreatorUserId = Number(latestSession?.hostId || userId) || null;
      roomCreatedAt = latestSession?.createdAt
        ? new Date(latestSession.createdAt).getTime()
        : Date.now();
      roomSessionNumber = Number(latestSession?.sessionNumber || 1);

      room = getRoomForSession(roomId, roomDbId, {
        sessionNumber: roomSessionNumber,
        creatorUserId: roomCreatorUserId,
        createdAt: roomCreatedAt,
        creatorName: roomCreatorUserId === userId ? cleanName : undefined,
        visibility: roomCreatorUserId === userId ? requestedVisibility : undefined,
      });
      room = await restoreRoomFromDatabase(
        roomId,
        roomDbId,
        {
          sessionNumber: roomSessionNumber,
          creatorUserId: roomCreatorUserId,
          createdAt: roomCreatedAt,
          creatorName: roomCreatorUserId === userId ? cleanName : undefined,
          visibility: roomCreatorUserId === userId ? requestedVisibility : undefined,
        },
        latestStoredState
      );
      [existingSocketId, existingUser] = findRoomUser(room, userId, cleanName);

      // Check if auction is ongoing and user is not already registered
      const dbSessionAlreadyStarted = latestSession?.status === "ongoing";
      if (room.status !== "waiting" || dbSessionAlreadyStarted) {
        const [existingRp] = roomDbId
          ? await pool.query(
              "SELECT id FROM room_players WHERE room_id = ? AND user_id = ? LIMIT 1",
              [roomDbId, userId]
            )
          : [[]];
        const isKnownLiveParticipant = Boolean(existingUser);
        if (existingRp.length === 0 && !isKnownLiveParticipant) {
          socket.emit("join_error", { reason: "Auction has already started. New participants cannot join." });
          return;
        }
      }

      if (cleanTeam) {
        const [teamRow] = await pool.query("SELECT id FROM teams WHERE name = ? LIMIT 1", [cleanTeam]);
        if (teamRow.length) {
          teamId = teamRow[0].id;
        }
      }

      const roomPlayerRow = await ensureRoomPlayerRow(roomDbId, userId, cleanTeam, teamId);
      budget = Number(roomPlayerRow.budget ?? 120);
      cleanTeam = cleanTeam || roomPlayerRow.teamName || null;
      if (roomPlayerRow.duplicateCount) {
        console.warn(
          `Cleaned ${roomPlayerRow.duplicateCount} duplicate room_players rows for room ${roomId} and user ${userId}`
        );
      }

      const [teamRows] = await pool.query(
        `SELECT c.id, c.name, c.role, c.batting_rating, c.bowling_rating, c.rating, c.base_price, c.country, tp.price
         FROM team_players tp
         JOIN cricketers c ON c.id = tp.player_id
         WHERE tp.room_id = ? AND tp.user_id = ?
         ORDER BY c.role, c.name`,
        [roomDbId, userId]
      );
      persistedTeam = teamRows;
    } catch (err) {
      console.error("DB error on join_room", formatDbError(err));
    }

    room = room || getRoomForSession(roomId, roomDbId, {
      sessionNumber: roomSessionNumber,
      creatorUserId: roomCreatorUserId,
      createdAt: roomCreatedAt,
    });

    socket.data.userId = userId;
    if (!existingUser) {
      [existingSocketId, existingUser] = findRoomUser(room, userId, cleanName);
    }
    if (existingSocketId) {
      // Clear any pending disconnect timeout for this user
      if (room.disconnectTimeouts.has(existingSocketId)) {
        clearTimeout(room.disconnectTimeouts.get(existingSocketId));
        room.disconnectTimeouts.delete(existingSocketId);
        console.log(`Cleared disconnect timeout for ${cleanName} on reconnection`);
      }
      migrateSocketIdentity(room, existingSocketId, socket.id);
    }

    if (cleanTeam) {
      const taken = Array.from(room.users.values()).some(
        (u) => u.teamName === cleanTeam && (!userId || u.userId !== userId)
      );
      if (taken) {
        socket.emit("team_taken", { team: cleanTeam });
        return;
      }
    }

    const team = persistedTeam.length ? persistedTeam : existingUser?.team || [];
    const mergedBudget = budget ?? existingUser?.budget ?? 120;
    const mergedUser = {
      username: cleanName,
      team,
      score: calculateScore(team),
      budget: mergedBudget,
      userId,
      teamName: cleanTeam || existingUser?.teamName || null,
    };

    if (!room.creatorUserId && userId) {
      syncRoomMetadata(room, {
        creatorUserId: userId,
        creatorName: cleanName,
        creatorTeamName: mergedUser.teamName,
        visibility: requestedVisibility || room.visibility,
      });
    } else if (room.creatorUserId && userId && room.creatorUserId === userId) {
      syncRoomMetadata(room, {
        creatorName: cleanName,
        creatorTeamName: mergedUser.teamName,
        visibility: requestedVisibility || room.visibility,
      });
    }

    room.users.set(socket.id, mergedUser);
    touchRoomActivity(room);

    // A user is NOT a spectator if:
    // 1. They were already in the room (existingUser)
    // 2. They have a team already (persistedTeam)
    // 3. The auction hasn't started yet
    const isReturningUser = !!existingUser || persistedTeam.length > 0;
    const isSpectator = !isReturningUser && room.status !== "waiting";

    if (isSpectator) {
      room.blockedUsers.add(socket.id);
      console.log(`User ${cleanName} joined room ${roomId} as a spectator`);
    } else {
      // Ensure they are not blocked if they are returning
      room.blockedUsers.delete(socket.id);
    }

    if (room.highestBidderUserId && userId && room.highestBidderUserId === userId) {
      room.highestBidder = socket.id;
      room.highestBidderName = cleanName;
    }

    socket.join(roomId);
    if (room.status === "running" && !room.timer) {
      startTimer(roomId, { preserveElapsed: true });
    }
    if (room.status === "picking" && room.selectDeadline && Date.now() > Number(room.selectDeadline)) {
      autoFinalizePlaying11(roomId);
    }
    if (room.status === "finished_finalized") {
      scheduleFinishedRoomClosure(roomId, room.dbId);
    }
    broadcastPlayers(roomId);
    const results = room.status === "finished_finalized" ? Array.from(room.playing11.values()).sort((a, b) => b.score - a.score) : null;
    const winner = results?.[0]?.teamName || results?.[0]?.username || "No winner";
    const isCreator = Boolean(room.creatorUserId && userId && room.creatorUserId === userId);

    socket.emit("join_ack", {
      userId,
      username: cleanName,
      team: team,
      budget: mergedBudget,
      teamName: mergedUser.teamName,
      currentPlayer: room.currentPlayer,
      currentBid: room.currentBid,
      lastBidder: getHighestBidderName(room),
      bidHistory: room.bidHistory || [],
      queue: getQueueState(room),
      roomStatus: room.status,
      roomDbId: room.dbId,
      roomSessionNumber: room.sessionNumber,
      roomVisibility: room.visibility,
      creatorName: room.creatorName,
      creatorTeamName: room.creatorTeamName,
      isCreator,
      isSpectator,
      isWithdrawn: room.withdrawnUsers.has(socket.id),
      disqualified: Array.from(room.disqualified).map((sid) => room.users.get(sid)?.teamName || room.users.get(sid)?.username).filter(Boolean),
      deadline: room.selectDeadline,
      selectionStartTime: room.selectionStartTime,
      timer: getTimerSnapshot(room),
      results,
      winner
    });
    if (room.currentPlayer) {
      socket.emit("new_player", room.currentPlayer);
    }
    socket.emit("bid_update", {
      amount: room.currentBid,
      by: getHighestBidderName(room),
      history: room.bidHistory || [],
      step: room.currentBid < 10 ? 0.2 : 0.5,
    });
    socket.emit("queue_update", getQueueState(room));
    socket.emit("budget_update", { budget: mergedBudget });
  });

  socket.on("voice_join", ({ roomId, username }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    touchRoomActivity(room);
    socket.data.roomId = roomId;
    if (username) socket.data.username = username;

    // Track voice user
    room.voiceUsers.add(socket.id);

    socket.join(roomId);

    // Notify others in the room
    socket.to(roomId).emit("user_joined_voice", {
      socketId: socket.id,
      username: username || socket.data.username || "Unknown"
    });

    // Send existing voice users to the new joiner
    const existing = Array.from(room.voiceUsers)
      .filter(id => id !== socket.id)
      .map(id => ({
        socketId: id,
        username: room.users.get(id)?.username || "Unknown"
      }));

    socket.emit("voice_room_users", { users: existing });
  });

  socket.on("voice_signal", (payload) => {
    if (!payload.to) return;
    const room = rooms.get(socket.data.roomId);
    touchRoomActivity(room);
    io.to(payload.to).emit("voice_signal", {
      from: socket.id,
      fromUsername: socket.data.username || "Unknown",
      signal: payload.signal,
    });
  });
  socket.on("voice_toggle_mic", (payload) => {
    const roomId = socket.data.roomId;
    if (roomId) {
      touchRoomActivity(rooms.get(roomId));
      socket.to(roomId).emit("voice_toggle_mic", {
        socketId: socket.id,
        isMuted: payload.isMuted,
      });
    }
  });

  socket.on("start_auction", async (roomId) => {
    const resolvedRoom = roomId || socket.data.roomId;
    if (!resolvedRoom) return;
    const room = getRoom(resolvedRoom);
    if (["starting", "transitioning", "running"].includes(room.status)) return;

    const requesterUserId = Number(socket.data.userId || 0) || null;
    const isCreator = Boolean(room.creatorUserId && requesterUserId && room.creatorUserId === requesterUserId);
    if (!isCreator) {
      socket.emit("start_auction_denied", { reason: "Only the room creator can start the auction." });
      return;
    }

    const participantCount = getActiveLobbyParticipants(room).length;
    if (participantCount < 2) {
      socket.emit("start_auction_denied", { reason: "At least 2 franchise owners are required to start the auction." });
      return;
    }

    // Reset room state for a fresh auction
    room.idx = 0;
    room.playersQueue = organizePlayersIntoSets(playersMaster);
    room.passedUsers = new Set();
    room.skipPoolUsers = new Set();
    room.withdrawnUsers = new Set();
    room.blockedUsers = new Set();
    room.bidHistory = [];
    room.currentPlayer = null;
    room.currentBid = 0;
    room.highestBidder = null;
    room.highestBidderUserId = null;
    room.highestBidderName = null;
    room.finalizingBid = false;
    room.playing11 = new Map();
    room.disqualified = new Set();
    room.selectionStartTime = null;
    room.selectDeadline = null;
    room.lastDbPersist = 0;
    setRoomStatus(room, "starting");
    touchRoomActivity(room);

    for (const user of room.users.values()) {
      user.team = [];
      user.score = 0;
    }

    persistAuctionState(resolvedRoom);
    broadcastPublicRooms();

    io.to(resolvedRoom).emit("start_auction");
    // Increased to 5 seconds to ensure all users have time to navigate and join
    // and to ensure DB deletes have finished.
    setTimeout(() => {
      console.log(`Starting first player for room ${resolvedRoom}`);
      startNextPlayer(resolvedRoom);
    }, 5000);
  });

  socket.on("place_bid", (amount) => handleBid(socket, amount));

  socket.on("skip_pool", () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.currentPlayer || room.status !== "running") return;
    touchRoomActivity(room);

    room.skipPoolUsers.add(socket.id);
    // Also mark as passed for the current player
    room.passedUsers.add(socket.id);
    const active = activeSockets(room);

    io.to(roomId).emit("skip_update", {
      count: room.skipPoolUsers.size,
      total: active.length,
      setName: room.currentPlayer?.setName
    });

    // Notify others that this user passed via skip vote
    room.bidHistory.push({
      amount: room.currentBid,
      by: socket.data.username,
      ts: Date.now(),
      note: "skip pool vote",
    });
    io.to(roomId).emit("bid_update", { amount: room.currentBid, by: room.highestBidderName, history: room.bidHistory.slice(-10) });
    persistAuctionState(roomId);

    // Check if everyone has either passed or voted to skip
    maybeAutoResolve(roomId, true);
  });

  socket.on("withdraw_bid", async () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    touchRoomActivity(room);

    room.blockedUsers.add(socket.id);
    room.withdrawnUsers.add(socket.id);
    persistAuctionState(roomId);

    if (room.currentPlayer && room.highestBidder === socket.id) {
      room.bidHistory.push({
        amount: room.currentBid,
        by: socket.data.username,
        ts: Date.now(),
        note: "withdraw (forced sale)",
      });
      await finalizeBid(roomId); // immediate sale to withdrawing highest bidder
    }

    if (activeSockets(room).length === 0) {
      endAuction(roomId);
    }
  });

  socket.on("pass_player", async () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.currentPlayer) return;
    touchRoomActivity(room);
    room.passedUsers.add(socket.id);
    room.bidHistory.push({
      amount: room.currentBid,
      by: socket.data.username,
      ts: Date.now(),
      note: "pass",
    });
    persistAuctionState(roomId);

    if (room.highestBidder === socket.id) {
      // Do nothing to the bid. The user is just passing further bids, 
      // but their current high bid should still stand.
      // Alternatively, we could prevent them from passing, 
      // but letting them pass means "I'm done with this player".
      // We only notify others of the pass.
      io.to(roomId).emit("bid_update", { amount: room.currentBid, by: room.highestBidderName, history: room.bidHistory.slice(-10) });
    }

    const totalPlayers = room.users.size;
    const activeIds = activeSockets(room);
    const everyonePassed = room.passedUsers.size >= activeIds.length;

    if (activeIds.length > 0 && everyonePassed) {
      if (room.timer) {
        clearInterval(room.timer);
        room.timer = null;
      }
      await finalizeBid(roomId);
    } else {
      // Check if the remaining active players are either high bidder or already passed
      maybeAutoResolve(roomId, true);
    }
    if (activeSockets(room).length === 0) {
      endAuction(roomId);
    }
  });

  socket.on("chat_message", ({ roomId, text }) => {
    const msg = (text || "").trim();
    if (!msg) return;
    const resolvedRoom = roomId || socket.data.roomId;
    if (!resolvedRoom) return;
    touchRoomActivity(rooms.get(resolvedRoom));
    io.to(resolvedRoom).emit("chat_message", {
      user: socket.data.username,
      text: msg,
      ts: Date.now(),
    });
  });

  socket.on("sync_lineup", (payload) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    touchRoomActivity(room);
    const user = room.users.get(socket.id);
    if (user) {
      user.partialLineup = Array.isArray(payload?.playerIds) ? payload.playerIds.map(Number) : [];
    }
  });

  socket.on("submit_playing11", (payload) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    touchRoomActivity(room);

    if (room.selectDeadline && Date.now() > room.selectDeadline) return;
    if (room.disqualified.has(socket.id)) {
      socket.emit("playing11_error", { reason: "Disqualified: insufficient squad to form valid XI" });
      return;
    }
    const ids = Array.isArray(payload?.playerIds) ? payload.playerIds.map(Number) : [];
    const evalResult = evaluatePlaying11(room, socket.id, ids);
    if (!evalResult.ok) {
      socket.emit("playing11_error", { reason: evalResult.reason });
      return;
    }
    const user = room.users.get(socket.id);
    const lineup = (user?.team || []).filter(p => ids.includes(p.id));

    room.playing11.set(socket.id, { 
      ...evalResult, 
      playerIds: ids, 
      username: socket.data.username, 
      teamName: user?.teamName || null,
      playerNames: lineup.map(p => p.name)
    });

    if (room.dbId && user?.userId) {
      persistPlaying11(room.dbId, user.userId, ids, evalResult.score)
        .catch((err) => console.error("Failed to persist playing11", formatDbError(err)));
    }
    persistAuctionState(roomId);

    const eligibleParticipantCount = getEligiblePlaying11Participants(room).length;
    const submissions = room.playing11.size;

    if (eligibleParticipantCount > 0 && submissions >= eligibleParticipantCount) {
      autoFinalizePlaying11(roomId);
    } else {
      socket.emit("playing11_ack", {
        ok: true,
        pending: Math.max(0, eligibleParticipantCount - submissions),
      });
    }
  });

  socket.on("leave_room", ({ roomId } = {}) => {
    const resolvedRoomId = roomId || socket.data.roomId;
    if (!resolvedRoomId) return;

    socket.leave(resolvedRoomId);

    const room = rooms.get(resolvedRoomId);
    if (!room) {
      if (socket.data.roomId === resolvedRoomId) {
        delete socket.data.roomId;
      }
      return;
    }

    room.voiceUsers.delete(socket.id);
    if (room.disconnectTimeouts.has(socket.id)) {
      clearTimeout(room.disconnectTimeouts.get(socket.id));
      room.disconnectTimeouts.delete(socket.id);
    }

    const preserveResultStageParticipant =
      room.status === "picking" || room.status === "finished_finalized";

    if (preserveResultStageParticipant) {
      if (socket.data.roomId === resolvedRoomId) {
        delete socket.data.roomId;
      }
      return;
    }

    room.users.delete(socket.id);
    room.blockedUsers.delete(socket.id);
    room.passedUsers.delete(socket.id);
    room.skipPoolUsers.delete(socket.id);
    room.withdrawnUsers.delete(socket.id);
    room.disqualified.delete(socket.id);
    room.playing11.delete(socket.id);

    if (room.highestBidder === socket.id) {
      room.highestBidder = null;
    }

    if (socket.data.roomId === resolvedRoomId) {
      delete socket.data.roomId;
    }

    broadcastPlayers(resolvedRoomId);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    // Remove from voice status immediately
    room.voiceUsers.delete(socket.id);
    io.to(roomId).emit("user_left_voice", { socketId: socket.id });

    // Start a 10-minute (600,000 ms) grace period before removing the user from room users
    const timeoutId = setTimeout(() => {
      if (room.users.has(socket.id)) {
        room.users.delete(socket.id);
        room.disconnectTimeouts.delete(socket.id);
        broadcastPlayers(roomId);
        console.log(`User ${socket.data.username} removed from room ${roomId} after grace period`);
      }
    }, 600000); // 10 minutes

    room.disconnectTimeouts.set(socket.id, timeoutId);

    io.to(roomId).emit("user_left_voice", { socketId: socket.id });
  });
});

async function bootstrap() {
  const db = getDatabaseSummary();
  try {
    await verifyDatabaseConnection();
    await ensureAuthSchema(pool);
    await ensureRoomSessionSchema(pool);
    console.log(`Supabase Postgres connected at ${db.host}:${db.port}/${db.database}`);
  } catch (err) {
    console.warn(
      `Supabase Postgres unavailable at ${db.host}:${db.port}/${db.database}; starting with fallback data where supported: ${formatDbError(err)}`
    );
  }

  playersMaster = await loadPlayers();
  teamsMaster = await loadTeams();
  try {
    await reconcilePersistedLiveRooms();
  } catch (err) {
    console.error("Failed to reconcile persisted rooms during bootstrap", formatDbError(err));
  }
  const port = process.env.PORT || 5000;
  server.listen(port, () => {
    console.log(`Auction server listening on ${port}`);
  });
}

bootstrap();
