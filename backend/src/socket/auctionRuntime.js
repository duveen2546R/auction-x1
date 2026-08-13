import { verifyAuthToken } from "../auth.js";
import pool, { formatDbError } from "../db.js";
import { loadPlayers } from "../playerStore.js";
import {
  createRoomSession,
  getLatestRoomSession,
} from "../roomSessions.js";
import { rooms, PUBLIC_ROOMS_CHANNEL } from "../runtimeRooms.js";
import { mergePurseEntries } from "../purseUtils.js";
import {
  clearAuctionState,
  ensureRoomPlayerIdentity,
  ensureRoomPlayerRow,
  findPersistedRoomParticipant,
  finishPersistedRoomSession,
  getResolvedPlayerIds,
  hasPersistedRoomPresence,
  isRecoverableStoredState,
  loadPersistedPlaying11Entries,
  loadPersistedRoomUsers,
  loadStoredAuctionState,
  loadUnfinishedRoomSnapshots,
  persistPlaying11,
} from "../repositories/auctionRepository.js";
import { sendAuctionCompletionEmails } from "../services/auctionEmailService.js";
import { organizePlayersIntoSets } from "../services/playerQueue.js";
import { createRoom } from "../services/roomFactory.js";
import {
  buildAutoLineup,
  calculateScore,
  canFormPlaying11,
  evaluatePlaying11,
  normalizePlayerIdList,
} from "../services/playing11Rules.js";
import { registerSocketHandlers } from "./registerSocketHandlers.js";

export function createAuctionRuntime(io) {
  let playersMaster = [];

  function activeSockets(room) {
    const connectedSockets = io.sockets.adapter.rooms.get(room.roomId);
    return Array.from(room.users.keys()).filter((id) =>
      !room.blockedUsers.has(id) && connectedSockets?.has(id)
    );
  }

  function getUniqueRuntimeParticipantKeys(room) {
    const uniqueParticipants = new Map();
    for (const [socketId, user] of room.users.entries()) {
      const identityKey =
        getStableIdentityKeyFromParts(user?.userId, user?.username) || `socket:${socketId}`;
      uniqueParticipants.set(identityKey, socketId);
    }
    return Array.from(uniqueParticipants.values());
  }

  function getDisqualifiedUserIds(room) {
    return Array.from(room.disqualified || [])
      .map((runtimeKey) => getRuntimeEntryUserId(room, runtimeKey))
      .filter((userId) => Number.isInteger(userId) && userId > 0);
  }

  function normalizeIdentityValue(value) {
    const cleanValue = String(value || "").trim().toLowerCase();
    return cleanValue || null;
  }

  function getStableIdentityKeyFromParts(userId, username) {
    const persistentUserKey = getPersistentUserKey(userId);
    if (persistentUserKey) return persistentUserKey;

    // Franchise choice is room state, not account identity.
    const normalizedUsername = normalizeIdentityValue(username);
    if (normalizedUsername) return `username:${normalizedUsername}`;

    return null;
  }

  function getRuntimeIdentityKey(room, runtimeKey, fallbackIdentity = {}) {
    const roomUser = room?.users?.get(runtimeKey) || {};
    return getStableIdentityKeyFromParts(
      roomUser.userId ?? fallbackIdentity.userId,
      roomUser.username ?? fallbackIdentity.username
    );
  }

  function findMatchingRuntimeKeyInCollection(collection, room, runtimeKey, fallbackIdentity = {}) {
    if (!collection) return null;
    if ((collection instanceof Map || collection instanceof Set) && collection.has(runtimeKey)) {
      return runtimeKey;
    }

    const targetIdentityKey = getRuntimeIdentityKey(room, runtimeKey, fallbackIdentity);
    if (!targetIdentityKey) return null;

    if (collection instanceof Map) {
      for (const [candidateKey, candidateValue] of collection.entries()) {
        const candidateIdentityKey = getRuntimeIdentityKey(room, candidateKey, {
          userId: candidateValue?.userId,
          teamName: candidateValue?.teamName,
          username: candidateValue?.username,
        });
        if (candidateIdentityKey === targetIdentityKey) {
          return candidateKey;
        }
      }
      return null;
    }

    for (const candidateKey of collection.values()) {
      if (getRuntimeIdentityKey(room, candidateKey) === targetIdentityKey) {
        return candidateKey;
      }
    }

    return null;
  }

  function getPlaying11EntryForRuntime(room, runtimeKey, fallbackIdentity = {}) {
    const matchedKey = findMatchingRuntimeKeyInCollection(
      room?.playing11,
      room,
      runtimeKey,
      fallbackIdentity
    );
    return matchedKey ? room.playing11.get(matchedKey) : null;
  }

  function getPlaying11DraftForRuntime(room, runtimeKey, fallbackIdentity = {}) {
    const matchedKey = findMatchingRuntimeKeyInCollection(
      room?.playing11Drafts,
      room,
      runtimeKey,
      fallbackIdentity
    );
    return matchedKey ? room.playing11Drafts.get(matchedKey) || [] : [];
  }

  async function getEligiblePlaying11SubmissionTarget(room) {
    if (!room) return 0;

    const disqualified = room.disqualified || new Set();
    const blockedUsers = room.blockedUsers || new Set();
    const runtimeParticipants = new Set();
    for (const [socketId, user] of room.users.entries()) {
      if (disqualified.has(socketId) || blockedUsers.has(socketId) || !Array.isArray(user?.team)) continue;
      const identityKey = getStableIdentityKeyFromParts(user?.userId, user?.username);
      if (identityKey) {
        runtimeParticipants.add(identityKey);
      }
    }
    const runtimeCount = runtimeParticipants.size;

    if (room.dbId) {
      const disqualifiedUserIds = getDisqualifiedUserIds(room);
      try {
        if (disqualifiedUserIds.length) {
          const placeholders = disqualifiedUserIds.map(() => "?").join(", ");
          const [rows] = await pool.query(
            `SELECT COUNT(DISTINCT user_id) AS count
             FROM room_players
             WHERE room_id = ?
               AND user_id NOT IN (${placeholders})`,
            [room.dbId, ...disqualifiedUserIds]
          );
          return Math.max(runtimeCount, Number(rows?.[0]?.count || 0));
        }

        const [rows] = await pool.query(
          `SELECT COUNT(DISTINCT user_id) AS count
           FROM room_players
           WHERE room_id = ?`,
          [room.dbId]
        );
        return Math.max(runtimeCount, Number(rows?.[0]?.count || 0));
      } catch (err) {
        console.error("Failed to count eligible Playing XI participants", formatDbError(err));
      }
    }

    return runtimeCount;
  }

  function getPlaying11SubmissionCount(room) {
    if (!room) return 0;
    const uniqueKeys = new Set();
    for (const [socketId, entry] of room.playing11.entries()) {
      const user = room.users.get(socketId);
      const identityKey = getStableIdentityKeyFromParts(
        entry?.userId ?? user?.userId,
        entry?.username ?? user?.username ?? socketId
      );
      if (identityKey) {
        uniqueKeys.add(identityKey);
      }
    }
    return uniqueKeys.size;
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
      rooms.set(roomId, createRoom(roomId, playersMaster));
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

    const nextRoom = createRoom(roomId, playersMaster);
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

  function countActiveMembers(room, collection) {
    const activeIds = new Set(activeSockets(room));
    let count = 0;

    for (const runtimeKey of collection || []) {
      if (activeIds.has(runtimeKey)) {
        count += 1;
      }
    }

    return count;
  }

  function getSkipUpdatePayload(room) {
    return {
      count: countActiveMembers(room, room?.skipPoolUsers),
      total: activeSockets(room).length,
      setName: room?.currentPlayer?.setName || null,
    };
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

  function emitJoinAck(socket, room) {
    if (!socket || !room) return;

    const currentUser = room.users.get(socket.id) || {};
    const userId = Number(currentUser.userId || socket.data.userId || 0) || null;
    const identityFallback = {
      userId,
      teamName: currentUser.teamName || socket.data.teamName || null,
      username: currentUser.username || socket.data.username || null,
    };
    const savedPlaying11Entry = getPlaying11EntryForRuntime(room, socket.id, identityFallback);
    const savedPlaying11Draft = getPlaying11DraftForRuntime(room, socket.id, identityFallback);
    const results =
      room.status === "finished_finalized"
        ? Array.from(room.playing11.values()).sort((a, b) => b.score - a.score)
        : null;
    const winner = results?.[0]?.teamName || results?.[0]?.username || "No winner";
    const isCreator = Boolean(room.creatorUserId && userId && room.creatorUserId === userId);

    socket.emit("join_ack", {
      userId,
      username: currentUser.username || socket.data.username,
      team: currentUser.team || [],
      budget: Number(currentUser.budget ?? 120),
      teamName: currentUser.teamName || socket.data.teamName || null,
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
      isSpectator: room.blockedUsers.has(socket.id),
      isWithdrawn: room.withdrawnUsers.has(socket.id),
      hasPassed: room.passedUsers.has(socket.id),
      hasVotedSkip: room.skipPoolUsers.has(socket.id),
      disqualified: Array.from(room.disqualified)
        .map((sid) => room.users.get(sid)?.teamName || room.users.get(sid)?.username)
        .filter(Boolean),
      deadline: room.selectDeadline,
      selectionStartTime: room.selectionStartTime,
      timer: getTimerSnapshot(room),
      savedPlaying11: savedPlaying11Entry?.playerIds || [],
      playing11Draft: savedPlaying11Draft,
      results,
      winner,
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
    socket.emit("skip_update", getSkipUpdatePayload(room));
    socket.emit("budget_update", { budget: Number(currentUser.budget ?? 120) });
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

  function getRoomUserDisplayName(room, runtimeKey, fallbackName = null) {
    const user = room?.users?.get(runtimeKey);
    return user?.teamName || user?.username || fallbackName || null;
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
    moveSetMembership(room.skipPoolUsers, previousSocketId, nextSocketId);
    moveSetMembership(room.blockedUsers, previousSocketId, nextSocketId);
    moveSetMembership(room.withdrawnUsers, previousSocketId, nextSocketId);
    moveSetMembership(room.disqualified, previousSocketId, nextSocketId);
    moveMapMembership(room.playing11, previousSocketId, nextSocketId);
    moveMapMembership(room.playing11Drafts, previousSocketId, nextSocketId);
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
      const userId = Number(entry?.userId || getRuntimeEntryUserId(room, runtimeKey) || 0);
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

  function serializePlaying11DraftEntries(room) {
    const entries = [];
    for (const [runtimeKey, playerIds] of room.playing11Drafts.entries()) {
      const userId = getRuntimeEntryUserId(room, runtimeKey);
      if (!userId) continue;

      entries.push({
        userId,
        playerIds: normalizePlayerIdList(playerIds),
      });
    }
    return entries;
  }

  function getPlayerNameById(playerId) {
    return playersMaster.find((player) => Number(player.id) === Number(playerId))?.name || null;
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
      room.highestBidder = room.highestBidderUserId
        ? persistedUserMap.get(Number(room.highestBidderUserId)) || null
        : null;
      room.highestBidderName =
        getRoomUserDisplayName(
          room,
          room.highestBidder,
          recovered?.highestBidderName || null
        ) || null;
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
          userId: Number(entry?.userId || roomUser?.userId || 0) || null,
          breakdown: entry?.breakdown || null,
        });
      }

      room.playing11Drafts = new Map();
      for (const entry of Array.isArray(recovered?.playing11Drafts) ? recovered.playing11Drafts : []) {
        const runtimeKey = persistedUserMap.get(Number(entry?.userId));
        if (!runtimeKey) continue;
        room.playing11Drafts.set(runtimeKey, normalizePlayerIdList(entry?.playerIds));
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


  async function getRoomPursesSnapshot(roomDbId) {
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

    const persistedPurses = purses.map((entry) => ({
      ...entry,
      players: playersByUser.get(entry.userId) || [],
    }));

    const runtimeRoom = Array.from(rooms.values()).find(
      (candidateRoom) => Number(candidateRoom?.dbId || 0) === Number(roomDbId || 0)
    );
    const runtimePurses = runtimeRoom
      ? Array.from(runtimeRoom.users.values())
          .filter(
            (user) =>
              user &&
              (user.teamName || (Array.isArray(user.team) && user.team.length > 0))
          )
          .map((user) => ({
            userId: Number(user.userId || 0) || null,
            username: user.username || null,
            teamName: user.teamName || null,
            budget: Number(user.budget ?? 0),
            players: Array.isArray(user.team) ? user.team : [],
          }))
      : [];

    return mergePurseEntries(persistedPurses, runtimePurses);
  }

  function broadcastPlayers(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    const players = activeSockets(room).map((socketId) => {
      const u = room.users.get(socketId);
      return {
        username: u.username,
        team: u.teamName || null,
        isCreator: Boolean(room.creatorUserId && u.userId === room.creatorUserId),
      };
    });

    io.to(roomId).emit("players_update", players);
    broadcastPublicRooms();
  }

  function removeRuntimeParticipant(room, runtimeKey) {
    if (!room || !runtimeKey) return;

    room.voiceUsers.delete(runtimeKey);
    room.blockedUsers.delete(runtimeKey);
    room.passedUsers.delete(runtimeKey);
    room.skipPoolUsers.delete(runtimeKey);
    room.withdrawnUsers.delete(runtimeKey);
    room.disqualified.delete(runtimeKey);
    room.playing11.delete(runtimeKey);
    room.playing11Drafts.delete(runtimeKey);
    room.users.delete(runtimeKey);

    if (room.highestBidder === runtimeKey) {
      room.highestBidder = null;
    }
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
      playing11Drafts: serializePlaying11DraftEntries(room),
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


  async function recoverMissedPlayers(roomId, { beforeIndex = null, excludeSetName = null, reason = "recovery" } = {}) {
    const room = rooms.get(roomId);
    if (!room || !room.dbId) return false;

    const upperBound = Number.isInteger(beforeIndex) ? Math.max(0, beforeIndex) : room.playersQueue.length;
    const candidates = room.playersQueue
      .slice(0, upperBound)
      .filter((player) => player && (!excludeSetName || player.setName !== excludeSetName));

    if (!candidates.length) return false;

    const resolvedPlayerIds = await getResolvedPlayerIds(
      room.dbId,
      candidates.map((player) => player.id)
    );
    const recoveredPlayers = [];
    const seen = new Set();

    for (const player of candidates) {
      const playerId = Number(player.id);
      if (!Number.isInteger(playerId) || playerId <= 0) continue;
      if (seen.has(playerId) || resolvedPlayerIds.has(playerId)) continue;
      seen.add(playerId);
      recoveredPlayers.push({ ...player });
    }

    if (!recoveredPlayers.length) return false;

    const insertAt = Number.isInteger(beforeIndex)
      ? Math.max(0, Math.min(beforeIndex, room.playersQueue.length))
      : Math.max(0, Math.min(room.idx, room.playersQueue.length));

    room.playersQueue.splice(insertAt, 0, ...recoveredPlayers);
    room.idx = insertAt;
    touchRoomActivity(room);
    emitQueueUpdate(roomId);
    io.to(roomId).emit("chat_message", {
      user: "SYSTEM",
      text: `Re-queued ${recoveredPlayers.length} skipped player${recoveredPlayers.length === 1 ? "" : "s"} for auction review before continuing.`,
      ts: Date.now(),
    });
    console.warn(
      `Recovered ${recoveredPlayers.length} unresolved queued player(s) in room ${roomId} before ${reason}`
    );
    await persistAuctionState(roomId);
    return true;
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

    // Find the next player in the queue who hasn't been sold or marked unsold.
    let nextPlayer = null;
    while (room.idx < room.playersQueue.length) {
      const candidate = room.playersQueue[room.idx];
      room.idx += 1;

      if (room.dbId) {
        try {
          const [resolved] = await pool.query(
            `SELECT player_id
             FROM (
               SELECT player_id
               FROM team_players
               WHERE room_id = ? AND player_id = ?
               UNION
               SELECT player_id
               FROM unsold_players
               WHERE room_id = ? AND player_id = ?
             ) resolved_players
             LIMIT 1`,
            [room.dbId, candidate.id, room.dbId, candidate.id]
          );
          if (resolved.length === 0) {
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
      const recoveredBeforeEnd = await recoverMissedPlayers(roomId, {
        beforeIndex: room.playersQueue.length,
        reason: "auction end",
      });
      if (recoveredBeforeEnd) {
        startNextPlayer(roomId);
        return;
      }
      endAuction(roomId);
      return;
    }

    const player = nextPlayer;
    const isNewSet = !room.currentPlayer || room.currentPlayer.setName !== player.setName;

    if (isNewSet) {
      const recoveredBeforeSetChange = await recoverMissedPlayers(roomId, {
        beforeIndex: Math.max(0, room.idx - 1),
        excludeSetName: player.setName,
        reason: `set change to ${player.setName}`,
      });
      if (recoveredBeforeSetChange) {
        startNextPlayer(roomId);
        return;
      }

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
        io.to(roomId).emit("skip_update", { ...getSkipUpdatePayload(room), setName: player.setName });

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
    io.to(roomId).emit("skip_update", { ...getSkipUpdatePayload(room), setName: player.setName });

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
        const resolveElapsedMs = Math.max(0, Date.now() - Number(room.lastBidAt || Date.now()));
        const suddenSystemSkip =
          room.passedUsers.size === 0 &&
          room.skipPoolUsers.size === 0 &&
          room.bidHistory.length === 0 &&
          resolveElapsedMs < 2500;

        if (room.dbId && !suddenSystemSkip) {
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

        if (suddenSystemSkip) {
          console.warn(
            `Detected sudden early no-bid skip for ${soldPlayer.name} in room ${roomId}; reinserting into queue`
          );
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
      if (active.length > 0 && countActiveMembers(room, room.skipPoolUsers) >= active.length) {
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

    const disqualified = new Set(room.disqualified);
    for (const [socketId, user] of room.users.entries()) {
      if (!canFormPlaying11(user.team)) disqualified.add(socketId);
    }
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

  async function autoFinalizePlaying11(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.status !== "picking" || room.finalizingPlaying11) return;
    room.finalizingPlaying11 = true;

    try {
      const allUserIds = getUniqueRuntimeParticipantKeys(room);
      const disqualified = room.disqualified || new Set();
      const persistJobs = [];

      for (const sid of allUserIds) {
        const user = room.users.get(sid);
        const identityFallback = {
          userId: user?.userId,
          teamName: user?.teamName,
          username: user?.username,
        };
        const disqualifiedKey = findMatchingRuntimeKeyInCollection(disqualified, room, sid, identityFallback);
        if (disqualifiedKey) continue;
        if (findMatchingRuntimeKeyInCollection(room.playing11, room, sid, identityFallback)) continue;
        if (!user || !user.team) continue;

        const savedDraftIds = getPlaying11DraftForRuntime(room, sid, identityFallback);
        const lineup = buildAutoLineup(user.team, savedDraftIds);
        if (lineup) {
          const evalResult = evaluatePlaying11(user, lineup.map((p) => p.id));
          if (evalResult.ok) {
            if (room.dbId && user.userId) {
              persistJobs.push(
                ensureRoomPlayerIdentity(room.dbId, user).catch((err) =>
                  console.error("Failed to repair room player before Playing XI finalize", formatDbError(err))
                )
              );
            }
            room.playing11.set(sid, { 
              ...evalResult, 
              playerIds: lineup.map((p) => p.id), 
              username: user.username, 
              teamName: user.teamName,
              userId: user.userId || null,
              playerNames: lineup.map(p => p.name)
            });
            if (room.dbId && user.userId) {
              persistJobs.push(
                persistPlaying11(room.dbId, user.userId, lineup.map((p) => p.id), evalResult.score)
                  .catch((err) => console.error("Failed to persist playing11", formatDbError(err)))
              );
            }
            const matchingDraftKey = findMatchingRuntimeKeyInCollection(room.playing11Drafts, room, sid, identityFallback);
            if (matchingDraftKey) {
              room.playing11Drafts.delete(matchingDraftKey);
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
      const dqUserIds = Array.from(disqualified)
        .map((sid) => getRuntimeEntryUserId(room, sid))
        .filter((userId) => Number.isInteger(userId) && userId > 0);

      io.to(roomId).emit("playing11_results", { winner: winnerName, results, disqualified: dqNames });
      scheduleFinishedRoomClosure(roomId, room.dbId);
      sendAuctionCompletionEmails(
        {
          roomDbId: room.dbId,
          roomCode: room.roomId,
          sessionNumber: room.sessionNumber,
          disqualifiedUserIds: dqUserIds,
        },
        { getPlayerNameById }
      ).catch((err) => {
        console.error("Failed to send auction completion emails", formatDbError(err));
      });
    } finally {
      room.finalizingPlaying11 = false;
    }
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

    const bidderName = getRoomUserDisplayName(room, socket.id, socket.data.teamName || socket.data.username);
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
    io.to(roomId).emit("skip_update", getSkipUpdatePayload(room));

    maybeAutoResolve(roomId, true);
    persistAuctionState(roomId);
  }

  const EMPTY_ROOM_RETENTION_MS = 30 * 60 * 1000;
  const INACTIVE_AUCTION_ROOM_RETENTION_MS = 30 * 60 * 1000;
  const ROOM_CLEANUP_INTERVAL_MS = 60 * 1000;
  const AUCTION_STALL_WATCHDOG_INTERVAL_MS = 5000;

  const stallWatchdogInterval = setInterval(async () => {
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
        continue;
      }

      if (
        room.status === "picking" &&
        Number(room.selectDeadline || 0) > 0 &&
        now >= Number(room.selectDeadline) &&
        !room.finalizingPlaying11
      ) {
        console.warn(`Watchdog auto-finalizing expired Playing XI phase in room ${roomId}`);
        await autoFinalizePlaying11(roomId);
      }
    }
  }, AUCTION_STALL_WATCHDOG_INTERVAL_MS);

  // Room cleanup:
  // 1. Empty rooms are purged after 2 hours.
  // 2. Auction/result rooms with no activity for 30 minutes are force-closed.
  const roomCleanupInterval = setInterval(async () => {
    const now = Date.now();
    let removedRoom = false;
    const roomsToForceClose = [];

    for (const [roomId, room] of Array.from(rooms.entries())) {
      const inactivityMs = now - Number(room.lastActivityAt || room.lastBidAt || room.createdAt || now);

      if (room.users.size === 0 && inactivityMs > EMPTY_ROOM_RETENTION_MS) {
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

      if (inactivityMs > INACTIVE_AUCTION_ROOM_RETENTION_MS) {
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

  registerSocketHandlers(io, {
    PUBLIC_ROOMS_CHANNEL,
    getPublicRoomsSnapshot,
    verifyAuthToken,
    rooms,
    startTimer,
    autoFinalizePlaying11,
    scheduleFinishedRoomClosure,
    emitJoinAck,
    findRoomUser,
    migrateSocketIdentity,
    touchRoomActivity,
    pool,
    formatDbError,
    getLatestRoomSession,
    loadStoredAuctionState,
    isRecoverableStoredState,
    getRoomForSession,
    restoreRoomFromDatabase,
    findPersistedRoomParticipant,
    hasPersistedRoomPresence,
    createRoomSession,
    ensureRoomPlayerRow,
    calculateScore,
    syncRoomMetadata,
    broadcastPlayers,
    getRoom,
    ensureRoomPlayerIdentity,
    createPlayerQueue: () => organizePlayersIntoSets(playersMaster),
    setRoomStatus,
    persistAuctionState,
    broadcastPublicRooms,
    getActiveLobbyParticipants,
    startNextPlayer,
    handleBid,
    getRoomUserDisplayName,
    getSkipUpdatePayload,
    maybeAutoResolve,
    finalizeBid,
    activeSockets,
    endAuction,
    countActiveMembers,
    findMatchingRuntimeKeyInCollection,
    evaluatePlaying11,
    persistPlaying11,
    getEligiblePlaying11SubmissionTarget,
    getPlaying11SubmissionCount,
    normalizePlayerIdList,
    removeRuntimeParticipant,
  });


  async function initialize() {
    playersMaster = await loadPlayers();
    try {
      await reconcilePersistedLiveRooms();
    } catch (err) {
      console.error("Failed to reconcile persisted rooms during bootstrap", formatDbError(err));
    }
  }

  function dispose() {
    clearInterval(stallWatchdogInterval);
    clearInterval(roomCleanupInterval);
  }

  return { initialize, dispose };
}
