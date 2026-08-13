export function registerSocketHandlers(io, dependencies) {
  const {
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
    createPlayerQueue,
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
  } = dependencies;

  io.on("connection", (socket) => {
    socket.on("watch_public_rooms", () => {
      socket.join(PUBLIC_ROOMS_CHANNEL);
      socket.emit("public_rooms_update", getPublicRoomsSnapshot());
    });
  
    socket.on("unwatch_public_rooms", () => {
      socket.leave(PUBLIC_ROOMS_CHANNEL);
    });
  
    socket.on("join_room", async ({ roomId, username, teamName, visibility, token, intent }) => {
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
  
      if (!authenticatedSession?.userId) {
        socket.emit("join_error", {
          code: "AUTH_REQUIRED_JOIN",
          reason: "Please log in before joining or reconnecting to a room.",
        });
        return;
      }
  
      const providedUsername = (username || "").trim();
      const rememberedUsername = (socket.data.username || "").trim();
      const providedTeamName = (teamName || "").trim();
      const rememberedTeamName = (socket.data.teamName || "").trim();
      let cleanName =
        authenticatedSession?.username ||
        providedUsername ||
        rememberedUsername ||
        `Player-${socket.id.slice(-4)}`;
      let cleanTeam = providedTeamName || rememberedTeamName || null;
      const joinIntent = intent === "create" ? "create" : intent === "resume" ? "resume" : "join";
      const requestedVisibility =
        visibility === "public" ? "public" : visibility === "private" ? "private" : null;
      socket.data.roomId = roomId;
      socket.data.username = cleanName;
      socket.data.teamName = cleanTeam;
  
      const liveRoom = rooms.get(roomId);
      const existingSocketUser = liveRoom?.users?.get(socket.id);
      if (liveRoom && existingSocketUser) {
        socket.data.username = existingSocketUser.username || cleanName;
        socket.data.teamName = existingSocketUser.teamName || cleanTeam || null;
        socket.data.userId = existingSocketUser.userId || authenticatedSession?.userId || null;
        socket.join(roomId);
        if (liveRoom.status === "running" && !liveRoom.timer) {
          startTimer(roomId, { preserveElapsed: true });
        }
        if (liveRoom.status === "picking" && liveRoom.selectDeadline && Date.now() > Number(liveRoom.selectDeadline)) {
          autoFinalizePlaying11(roomId);
        }
        if (liveRoom.status === "finished_finalized") {
          scheduleFinishedRoomClosure(roomId, liveRoom.dbId);
        }
        emitJoinAck(socket, liveRoom);
        return;
      }
  
      if (liveRoom) {
        let runtimeSocketId = null;
        let runtimeUser = null;
        const rememberedUserId = authenticatedSession?.userId || socket.data.userId || null;
  
        [runtimeSocketId, runtimeUser] = findRoomUser(liveRoom, rememberedUserId, cleanName);
  
        if (runtimeSocketId && runtimeUser) {
          if (liveRoom.disconnectTimeouts.has(runtimeSocketId)) {
            clearTimeout(liveRoom.disconnectTimeouts.get(runtimeSocketId));
            liveRoom.disconnectTimeouts.delete(runtimeSocketId);
          }
  
          migrateSocketIdentity(liveRoom, runtimeSocketId, socket.id);
          const recoveredUser = liveRoom.users.get(socket.id) || runtimeUser;
  
          socket.data.username = recoveredUser.username || cleanName;
          socket.data.teamName = recoveredUser.teamName || cleanTeam || null;
          socket.data.userId = recoveredUser.userId || rememberedUserId || null;
          socket.join(roomId);
          touchRoomActivity(liveRoom);
  
          if (liveRoom.status === "running" && !liveRoom.timer) {
            startTimer(roomId, { preserveElapsed: true });
          }
          if (liveRoom.status === "picking" && liveRoom.selectDeadline && Date.now() > Number(liveRoom.selectDeadline)) {
            autoFinalizePlaying11(roomId);
          }
          if (liveRoom.status === "finished_finalized") {
            scheduleFinishedRoomClosure(roomId, liveRoom.dbId);
          }
  
          broadcastPlayers(roomId);
          emitJoinAck(socket, liveRoom);
          return;
        }
      }
  
      let userId = authenticatedSession?.userId || socket.data.userId || null;
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
      let matchedPersistedParticipant = null;
      let hasPersistedPresence = false;
      let isKnownPersistedParticipant = false;
      let isKnownRoomHost = false;
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
        socket.data.userId = userId;
  
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
          if (joinIntent !== "create") {
            socket.emit("join_error", {
              code: latestSession ? "ROOM_CLOSED" : "ROOM_NOT_FOUND",
              reason: latestSession ? "This room is already closed." : "Room code not found.",
            });
            return;
          }
  
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
        isKnownRoomHost = Boolean(roomCreatorUserId && userId && roomCreatorUserId === userId);
        roomCreatedAt = latestSession?.createdAt
          ? new Date(latestSession.createdAt).getTime()
          : Date.now();
        roomSessionNumber = Number(latestSession?.sessionNumber || 1);
        const dbSessionAlreadyStarted = latestSession?.status === "ongoing";
  
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
  
        if (!existingUser && roomDbId) {
          matchedPersistedParticipant = await findPersistedRoomParticipant(roomDbId, {
            userId,
            username: cleanName,
          });
          if (matchedPersistedParticipant) {
            userId = matchedPersistedParticipant.userId || userId;
            cleanName = matchedPersistedParticipant.username || cleanName;
            const allowFranchiseSelectionChange =
              Boolean(cleanTeam) && room.status === "waiting" && !dbSessionAlreadyStarted;
            if (!allowFranchiseSelectionChange) {
              cleanTeam = matchedPersistedParticipant.teamName || cleanTeam;
            }
            socket.data.username = cleanName;
            socket.data.userId = userId;
            socket.data.teamName = cleanTeam;
            [existingSocketId, existingUser] = findRoomUser(room, userId, cleanName);
          }
        }
  
        // Check if auction is ongoing and user is not already registered
        if (room.status !== "waiting" || dbSessionAlreadyStarted) {
          hasPersistedPresence = await hasPersistedRoomPresence(roomDbId, userId);
          const isKnownLiveParticipant = Boolean(existingUser);
          isKnownPersistedParticipant = Boolean(matchedPersistedParticipant) || hasPersistedPresence;
          const canResumeActiveAuction =
            isKnownLiveParticipant || isKnownPersistedParticipant || isKnownRoomHost;
          if (!canResumeActiveAuction) {
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
      socket.data.teamName = cleanTeam || existingUser?.teamName || null;
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
      // 2. They have persisted room membership, even with zero purchases
      // 3. They are the room host for this session
      const isReturningUser =
        !!existingUser ||
        persistedTeam.length > 0 ||
        hasPersistedPresence ||
        isKnownPersistedParticipant ||
        isKnownRoomHost;
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
        room.highestBidderName = mergedUser.teamName || cleanName;
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
      emitJoinAck(socket, room);
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
  
      if (room.dbId) {
        const identityRepairs = Array.from(room.users.values())
          .filter((user) => Number.isInteger(Number(user?.userId || 0)) && Number(user.userId) > 0)
          .map((user) =>
            ensureRoomPlayerIdentity(room.dbId, user).catch((err) => {
              console.error("Failed to persist room player before auction start", formatDbError(err));
            })
          );
  
        if (identityRepairs.length) {
          await Promise.allSettled(identityRepairs);
        }
      }
  
      // Reset room state for a fresh auction
      room.idx = 0;
      room.playersQueue = createPlayerQueue();
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
      room.finalizingPlaying11 = false;
      room.playing11 = new Map();
      room.playing11Drafts = new Map();
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
  
      const actorName = getRoomUserDisplayName(room, socket.id, socket.data.teamName || socket.data.username);
      room.skipPoolUsers.add(socket.id);
      // Also mark as passed for the current player
      room.passedUsers.add(socket.id);
      io.to(roomId).emit("skip_update", getSkipUpdatePayload(room));
  
      // Notify others that this user passed via skip vote
      room.bidHistory.push({
        amount: room.currentBid,
        by: actorName,
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
  
      const actorName = getRoomUserDisplayName(room, socket.id, socket.data.teamName || socket.data.username);
      room.blockedUsers.add(socket.id);
      room.withdrawnUsers.add(socket.id);
      persistAuctionState(roomId);
  
      if (room.currentPlayer && room.highestBidder === socket.id) {
        room.bidHistory.push({
          amount: room.currentBid,
          by: actorName,
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
      const actorName = getRoomUserDisplayName(room, socket.id, socket.data.teamName || socket.data.username);
      room.passedUsers.add(socket.id);
      room.bidHistory.push({
        amount: room.currentBid,
        by: actorName,
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
  
      const activeIds = activeSockets(room);
      const everyonePassed = countActiveMembers(room, room.passedUsers) >= activeIds.length;
  
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
  
    socket.on("submit_playing11", async (payload) => {
      const roomId = socket.data.roomId;
      const room = rooms.get(roomId);
      if (!room) return;
      touchRoomActivity(room);
      const identityFallback = {
        userId: socket.data.userId || null,
        teamName: socket.data.teamName || null,
        username: socket.data.username || null,
      };
  
      if (room.selectDeadline && Date.now() > room.selectDeadline) {
        autoFinalizePlaying11(roomId);
        socket.emit("playing11_error", { reason: "Playing XI timer ended. Finalizing results now." });
        return;
      }
      if (findMatchingRuntimeKeyInCollection(room.disqualified, room, socket.id, identityFallback)) {
        socket.emit("playing11_error", { reason: "Disqualified: insufficient squad to form valid XI" });
        return;
      }
      if (findMatchingRuntimeKeyInCollection(room.playing11, room, socket.id, identityFallback)) {
        socket.emit("playing11_error", { reason: "Playing XI already locked for this team." });
        return;
      }
      const ids = Array.isArray(payload?.playerIds) ? payload.playerIds.map(Number) : [];
      const evalResult = evaluatePlaying11(room.users.get(socket.id), ids);
      if (!evalResult.ok) {
        socket.emit("playing11_error", { reason: evalResult.reason });
        return;
      }
      const user = room.users.get(socket.id);
      const lineup = (user?.team || []).filter(p => ids.includes(p.id));
  
      if (room.dbId && user?.userId) {
        await ensureRoomPlayerIdentity(room.dbId, user).catch((err) => {
          console.error("Failed to repair room player before Playing XI submit", formatDbError(err));
        });
      }
  
      room.playing11.set(socket.id, { 
        ...evalResult, 
        playerIds: ids, 
        username: user?.username || socket.data.username, 
        teamName: user?.teamName || socket.data.teamName || null,
        userId: user?.userId || socket.data.userId || null,
        playerNames: lineup.map(p => p.name)
      });
      const existingDraftKey = findMatchingRuntimeKeyInCollection(room.playing11Drafts, room, socket.id, identityFallback);
      if (existingDraftKey) {
        room.playing11Drafts.delete(existingDraftKey);
      }
  
      if (room.dbId && user?.userId) {
        persistPlaying11(room.dbId, user.userId, ids, evalResult.score)
          .catch((err) => console.error("Failed to persist playing11", formatDbError(err)));
      }
      persistAuctionState(roomId);
  
      const eligibleParticipantCount = await getEligiblePlaying11SubmissionTarget(room);
      const submissions = getPlaying11SubmissionCount(room);
  
      if (eligibleParticipantCount > 0 && submissions >= eligibleParticipantCount) {
        autoFinalizePlaying11(roomId);
      } else {
        socket.emit("playing11_ack", {
          ok: true,
          pending: Math.max(0, eligibleParticipantCount - submissions),
          playerIds: ids,
        });
      }
    });
  
    socket.on("update_playing11_draft", (payload) => {
      const roomId = socket.data.roomId;
      const room = rooms.get(roomId);
      if (!room || room.status !== "picking") return;
      const identityFallback = {
        userId: socket.data.userId || null,
        teamName: socket.data.teamName || null,
        username: socket.data.username || null,
      };
      if (findMatchingRuntimeKeyInCollection(room.disqualified, room, socket.id, identityFallback)) return;
      if (findMatchingRuntimeKeyInCollection(room.playing11, room, socket.id, identityFallback)) return;
  
      const ids = normalizePlayerIdList(payload?.playerIds).slice(0, 11);
      const existingDraftKey = findMatchingRuntimeKeyInCollection(room.playing11Drafts, room, socket.id, identityFallback);
      if (existingDraftKey && existingDraftKey !== socket.id) {
        room.playing11Drafts.delete(existingDraftKey);
      }
      room.playing11Drafts.set(socket.id, ids);
      touchRoomActivity(room);
      persistAuctionState(roomId);
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
  
      removeRuntimeParticipant(room, socket.id);
  
      if (socket.data.roomId === resolvedRoomId) {
        delete socket.data.roomId;
      }
  
      broadcastPlayers(resolvedRoomId);
      if (room.currentPlayer) {
        io.to(resolvedRoomId).emit("skip_update", getSkipUpdatePayload(room));
        maybeAutoResolve(resolvedRoomId, true);
        persistAuctionState(resolvedRoomId);
      }
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
          removeRuntimeParticipant(room, socket.id);
          room.disconnectTimeouts.delete(socket.id);
          broadcastPlayers(roomId);
          if (room.currentPlayer) {
            io.to(roomId).emit("skip_update", getSkipUpdatePayload(room));
            maybeAutoResolve(roomId, true);
            persistAuctionState(roomId);
          }
          console.log(`User ${socket.data.username} removed from room ${roomId} after grace period`);
        }
      }, 600000); // 10 minutes
  
      room.disconnectTimeouts.set(socket.id, timeoutId);
      broadcastPlayers(roomId);
      if (room.currentPlayer) {
        io.to(roomId).emit("skip_update", getSkipUpdatePayload(room));
        maybeAutoResolve(roomId, true);
        persistAuctionState(roomId);
      }
    });
  });
}
