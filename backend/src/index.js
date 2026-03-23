import http from "http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import "./env.js";
import pool, { formatDbError, getDatabaseSummary, verifyDatabaseConnection } from "./db.js";
import { loadPlayers } from "./playerStore.js";
import { loadTeams } from "./teamStore.js";
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
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", process.env.FRONTEND_ORIGIN].filter(Boolean),
    methods: ["GET", "POST"],
  },
});

const rooms = new Map();
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
    playersQueue: queuedPlayers,
    idx: 0,
    users: new Map(),
    currentPlayer: null,
    currentBid: 0,
    highestBidder: null,
    highestBidderUserId: null,
    highestBidderName: null,
    timer: null,
    timeLeft: 0,
    status: "waiting",
    lastBidAt: Date.now(),
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
    finalizingBid: false,
    disconnectTimeouts: new Map(), // socketId -> timeout
  };
}

function activeSockets(room) {
  const connectedSockets = io.sockets.adapter.rooms.get(room.roomId);
  return Array.from(room.users.keys()).filter((id) => 
    !room.blockedUsers.has(id) && connectedSockets?.has(id)
  );
}

function getRoom(roomId, dbId = null) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, createRoom(roomId));
  }
  const room = rooms.get(roomId);
  if (dbId && !room.dbId) {
    room.dbId = dbId;
  }
  return room;
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

async function ensureRoomPlayerRow(roomDbId, userId, teamName, teamId) {
  const [existingRows] = await pool.query(
    `SELECT id, budget, team_name, team_id
     FROM room_players
     WHERE room_id = ? AND user_id = ?
     ORDER BY id DESC`,
    [roomDbId, userId]
  );

  if (!existingRows.length) {
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

    await pool.query(
      "INSERT INTO room_players (room_id, user_id, budget, team_name, team_id) VALUES (?, ?, ?, ?, ?)",
      [roomDbId, userId, initialBudget, teamName, teamId]
    );

    return {
      budget: initialBudget,
      teamName: teamName || null,
    };
  }

  const [latestRow, ...duplicateRows] = existingRows;
  console.log(`Found existing room_player row for user ${userId} in room ${roomDbId}. Current budget: ${latestRow.budget}`);
  const nextTeamName = teamName || latestRow.team_name || null;
  const nextTeamId = teamId ?? latestRow.team_id ?? null;

  await pool.query(
    "UPDATE room_players SET team_name = ?, team_id = ? WHERE id = ?",
    [nextTeamName, nextTeamId, latestRow.id]
  );

  if (duplicateRows.length) {
    const duplicateIds = duplicateRows.map((row) => row.id);
    const placeholders = duplicateIds.map(() => "?").join(", ");
    await pool.query(
      `DELETE FROM room_players WHERE id IN (${placeholders})`,
      duplicateIds
    );
  }

  return {
    budget: Number(latestRow.budget ?? 120),
    teamName: nextTeamName,
    duplicateCount: duplicateRows.length,
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
    }));
    
  io.to(roomId).emit("players_update", players);
}

function startTimer(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.lastBidAt = Date.now();
  room.warnedOnce = false;
  room.warnedTwice = false;

  if (room.timer) clearInterval(room.timer);
  room.timer = setInterval(async () => {
    const idleMs = Date.now() - (room.lastBidAt || 0);
    const totalDuration = room.totalDuration || 13000;
    const remainingMs = Math.max(0, totalDuration - idleMs);

    io.to(roomId).emit("timer_tick", { 
      remainingMs, 
      totalMs: totalDuration,
      percent: (remainingMs / totalDuration) * 100 
    });

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

function maybeAutoResolve(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.currentPlayer) return;
  const activeIds = activeSockets(room);
  if (activeIds.length === 0) {
    endAuction(roomId);
    return;
  }

  // If every active player has either passed, is currently the high bidder, or voted to skip,
  // no more bidding is possible. Finalize immediately.
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
  };
}

async function persistAuctionState(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.dbId) return;

  const state = {
    idx: room.idx,
    status: room.status,
    currentBid: room.currentBid,
    highestBidderUserId: room.highestBidderUserId,
    highestBidderName: room.highestBidderName,
    lastBidAt: room.lastBidAt,
    totalDuration: room.totalDuration,
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
  room.status = "transitioning";
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
        const [unsold] = await pool.query(
          "SELECT id FROM unsold_players WHERE room_id = ? AND player_id = ? LIMIT 1",
          [room.dbId, candidate.id]
        );
        if (sold.length === 0 && unsold.length === 0) {
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
      room.status = "running";
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
      maybeAutoResolve(roomId);
      await persistAuctionState(roomId);
    }, 4000); // 4 second delay for the set transition animation
    return;
  }

  room.currentPlayer = player;
  room.currentBid = Number(player.base_price || 0);
  room.highestBidder = null;
  room.highestBidderUserId = null;
  room.highestBidderName = null;
  room.status = "running";
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
  maybeAutoResolve(roomId);
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
    // Record skipped players as unsold in DB
    if (room.dbId) {
      try {
        await pool.query(
          "INSERT INTO unsold_players (room_id, player_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
          [room.dbId, room.playersQueue[nextPoolIdx].id]
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
  room.status = "sold";
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
      io.to(roomId).emit("pool_skipped", { setName: room.currentPlayer?.setName });
      setTimeout(() => skipPool(roomId), 1500);
    } else {
      setTimeout(() => startNextPlayer(roomId), 1500);
    }
  }
}

function endAuction(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.status === "picking") return;
  room.status = "picking";
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
  const lineup = [];
  
  const byScore = (arr) =>
    arr.slice().sort((a, b) => (Number(b.batting_rating ?? b.rating ?? 0) + Number(b.bowling_rating ?? b.rating ?? 0)) -
      (Number(a.batting_rating ?? a.rating ?? 0) + Number(a.bowling_rating ?? a.rating ?? 0)));

  const overseas = (p) => (p.country || "").toLowerCase() !== "india";
  const pushWithCap = (p) => {
    if (lineup.find(x => x.id === p.id)) return false;
    if (lineup.length >= 11) return false;
    const osCount = lineup.filter(overseas).length;
    if (overseas(p) && osCount >= 4) return false;
    lineup.push(p);
    return true;
  };

  const categorized = team.map(p => {
    const role = (p.role || "").toLowerCase();
    return {
      p,
      isAr: role.includes("all"),
      isBat: role.includes("bat") || role.includes("open") || role.includes("middle"),
      isBowl: role.includes("bowl") || role.includes("pace") || role.includes("spin"),
      isWk: role.includes("keep") || role.includes("wk")
    };
  });

  const wks = byScore(categorized.filter(c => c.isWk).map(c => c.p));
  const ars = byScore(categorized.filter(c => c.isAr).map(c => c.p));
  const bats = byScore(categorized.filter(c => c.isBat && !c.isAr && !c.isWk).map(c => c.p));
  const bowls = byScore(categorized.filter(c => c.isBowl && !c.isAr).map(c => c.p));

  // 1. Must have 1 WK
  for (const p of wks) { if (pushWithCap(p)) break; }
  if (lineup.length < 1) return null; // No WK available

  // 2. Add pure Batsmen to meet min 3 (WKs count as Batsmen)
  for (const p of bats) {
    if (lineup.length >= 11) break;
    const currentBats = lineup.filter(p => {
      const r = (p.role || "").toLowerCase();
      return (r.includes("bat") || r.includes("open") || r.includes("middle") || r.includes("keep") || r.includes("wk")) && !r.includes("all");
    }).length;
    if (currentBats >= 3) break;
    pushWithCap(p);
  }

  // 3. Add pure Bowlers to meet min 2
  for (const p of bowls) {
    if (lineup.length >= 11) break;
    const currentBowls = lineup.filter(p => {
      const r = (p.role || "").toLowerCase();
      return (r.includes("bowl") || r.includes("pace") || r.includes("spin")) && !r.includes("all");
    }).length;
    if (currentBowls >= 2) break;
    pushWithCap(p);
  }

  // 4. Add All-rounders (up to 4)
  for (const p of ars) {
    if (lineup.length >= 11) break;
    const currentArs = lineup.filter(p => (p.role || "").toLowerCase().includes("all")).length;
    if (currentArs >= 4) break;
    pushWithCap(p);
  }

  // 5. Fill remaining with best available
  const remaining = byScore(team.filter(p => !lineup.find(x => x.id === p.id)));
  for (const p of remaining) {
    if (lineup.length >= 11) break;
    pushWithCap(p);
  }

  if (lineup.length !== 11) return null;
  const val = evaluatePlaying11({ users: new Map([["tmp", { team: team }]]) }, "tmp", lineup.map((p) => p.id));
  if (!val.ok) return null;
  return lineup;
}

async function autoFinalizePlaying11(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.status !== "picking") return;
  const active = activeSockets(room);
  const disqualified = room.disqualified || new Set();

  for (const sid of active) {
    if (disqualified.has(sid)) continue;
    if (room.playing11.has(sid)) continue;
    const user = room.users.get(sid);
    const lineup = buildAutoLineup(user.team || []);
    if (lineup) {
      const evalResult = evaluatePlaying11(room, sid, lineup.map((p) => p.id));
      if (evalResult.ok) {
        room.playing11.set(sid, { ...evalResult, playerIds: lineup.map((p) => p.id), username: user.username });
        if (room.dbId && user.userId) {
          persistPlaying11(room.dbId, user.userId, lineup.map((p) => p.id), evalResult.score)
            .catch((err) => console.error("Failed to persist playing11", formatDbError(err)));
        }
      } else {
        disqualified.add(sid);
      }
    } else {
      disqualified.add(sid);
    }
  }

  room.disqualified = disqualified;
  if (room.playing11.size + disqualified.size >= active.length) {
    const results = Array.from(room.playing11.values()).sort((a, b) => b.score - a.score);
    const winnerName = results[0]?.teamName || results[0]?.username || "No winner";
    const dqNames = Array.from(disqualified).map((sid) => room.users.get(sid)?.teamName || room.users.get(sid)?.username).filter(Boolean);
    io.to(roomId).emit("playing11_results", { winner: winnerName, results, disqualified: dqNames });
    room.status = "finished_finalized";
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
  
  const bidderName = user?.teamName || socket.data.username;
  room.currentBid = numericBid;
  room.highestBidder = socket.id;
  room.highestBidderUserId = user?.userId || null;
  room.highestBidderName = bidderName;
  room.lastBidAt = Date.now();
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
  
  maybeAutoResolve(roomId);
  persistAuctionState(roomId);

  if (room.dbId && user?.userId && room.currentPlayer?.id) {
    pool
      .query(
        "INSERT INTO bids (room_id, player_id, user_id, bid_amount) VALUES (?, ?, ?, ?)",
        [room.dbId, room.currentPlayer.id, user.userId, numericBid]
      )
      .catch((err) => console.error("Failed to persist bid", err.message));
  }
}

io.on("connection", (socket) => {
  socket.on("join_room", async ({ roomId, username, teamName }) => {
    if (!roomId) return;
    const cleanName = (username || "").trim() || `Player-${socket.id.slice(-4)}`;
    let cleanTeam = (teamName || "").trim() || null;
    socket.data.roomId = roomId;
    socket.data.username = cleanName;

    let userId = null;
    let roomDbId = null;
    let budget = 120;
    let teamId = null;
    let persistedTeam = [];
    try {
      const [users] = await pool.query("SELECT id FROM users WHERE username = ? LIMIT 1", [cleanName]);
      if (users.length) {
        userId = users[0].id;
      } else {
        const [insert] = await pool.query("INSERT INTO users (username) VALUES (?) RETURNING id", [cleanName]);
        userId = insert.insertId;
      }

      const [insertRoom] = await pool.query(
        `INSERT INTO rooms (room_code, host_id)
         VALUES (?, ?)
         ON CONFLICT (room_code) DO UPDATE SET room_code = EXCLUDED.room_code
         RETURNING id`,
        [roomId, userId]
      );
      roomDbId = insertRoom.insertId;

      // Check if auction is ongoing and user is not already registered
      const room = getRoom(roomId, roomDbId);
      if (room.status !== "waiting") {
        const [existingRp] = await pool.query(
          "SELECT id FROM room_players WHERE room_id = ? AND user_id = ? LIMIT 1",
          [roomDbId, userId]
        );
        if (existingRp.length === 0) {
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

    const room = getRoom(roomId, roomDbId);
    
    // Attempt state recovery if room is fresh
    if (room.idx === 0 && room.status === "waiting") {
      try {
        const [stateRows] = await pool.query("SELECT state FROM auction_state WHERE room_id = ?", [roomDbId]);
        if (stateRows.length) {
          const recovered = stateRows[0].state;
          console.log(`Recovering state for room ${roomId}:`, recovered);
          room.idx = recovered.idx || 0;
          room.status = recovered.status || "waiting";
          room.currentBid = recovered.currentBid || 0;
          room.highestBidderUserId = recovered.highestBidderUserId;
          room.highestBidderName = recovered.highestBidderName;
          room.lastBidAt = recovered.lastBidAt;
          room.totalDuration = recovered.totalDuration || 13000;
          room.selectionStartTime = recovered.selectionStartTime;
          room.selectDeadline = recovered.selectDeadline;

          // Re-fetch current player if needed
          if (room.idx > 0 && !room.currentPlayer) {
            room.currentPlayer = room.playersQueue[room.idx - 1];
          }
        }
      } catch (err) {
        console.error("State recovery failed", err.message);
      }
    }

    socket.data.userId = userId;
    const [existingSocketId, existingUser] = findRoomUser(room, userId, cleanName);
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
    room.users.set(socket.id, mergedUser);

    // If this is a completely new user (not re-joining) and the auction already started, 
    // mark them as a spectator (blocked from bidding).
    const isNewUser = !existingUser;
    const isSpectator = isNewUser && room.status !== "waiting";
    
    if (isSpectator) {
      room.blockedUsers.add(socket.id);
      console.log(`User ${cleanName} joined room ${roomId} as a spectator`);
    }

    if (room.highestBidderUserId && userId && room.highestBidderUserId === userId) {
      room.highestBidder = socket.id;
      room.highestBidderName = cleanName;
    }

    socket.join(roomId);
    broadcastPlayers(roomId);
    socket.emit("join_ack", {
      userId,
      team: team,
      budget: mergedBudget,
      teamName: mergedUser.teamName,
      currentPlayer: room.currentPlayer,
      currentBid: room.currentBid,
      lastBidder: getHighestBidderName(room),
      bidHistory: room.bidHistory || [],
      queue: getQueueState(room),
      roomStatus: room.status,
      isSpectator,
      isWithdrawn: room.withdrawnUsers.has(socket.id),
      disqualified: Array.from(room.disqualified).map((sid) => room.users.get(sid)?.username).filter(Boolean),
      deadline: room.selectDeadline,
      selectionStartTime: room.selectionStartTime,
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
    
    // Notify others in the room to initiate peer connections
    socket.to(roomId).emit("user_joined_voice", { socketId: socket.id, username: cleanName });
  });

  socket.on("voice_signal", (payload) => {
    io.to(payload.to).emit("voice_signal", {
      from: socket.id,
      signal: payload.signal,
    });
  });

  socket.on("voice_toggle_mic", (payload) => {
    const roomId = socket.data.roomId;
    if (roomId) {
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
    if (room.status === "running") return;
    
    // Clear previous room data if it has a DB ID
    if (room.dbId) {
      try {
        await pool.query("DELETE FROM team_players WHERE room_id = ?", [room.dbId]);
        await pool.query("DELETE FROM unsold_players WHERE room_id = ?", [room.dbId]);
        await pool.query("DELETE FROM bids WHERE room_id = ?", [room.dbId]);
        // Also reset budgets for room_players to default
        const [teams] = await pool.query("SELECT id, budget FROM teams");
        const budgetMap = new Map(teams.map(t => [t.id, t.budget]));
        
        const [rps] = await pool.query("SELECT id, team_id FROM room_players WHERE room_id = ?", [room.dbId]);
        for (const rp of rps) {
          const budget = rp.team_id ? budgetMap.get(rp.team_id) || 120 : 120;
          await pool.query("UPDATE room_players SET budget = ? WHERE id = ?", [budget, rp.id]);
        }
        console.log(`Cleared previous session data for room ${resolvedRoom} (ID: ${room.dbId})`);
      } catch (err) {
        console.error("Failed to clear previous room data", err.message);
      }
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

    io.to(resolvedRoom).emit("start_auction");
    // Increased to 3 seconds to ensure all users have time to navigate and join
    setTimeout(() => startNextPlayer(resolvedRoom), 3000);
  });

  socket.on("place_bid", (amount) => handleBid(socket, amount));

  socket.on("skip_pool", () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.currentPlayer || room.status !== "running") return;

    room.skipPoolUsers.add(socket.id);
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
      note: "skip vote (pass)",
    });
    io.to(roomId).emit("bid_update", { amount: room.currentBid, by: room.highestBidderName, history: room.bidHistory.slice(-10) });
    
    // Check if everyone has either passed or voted to skip
    maybeAutoResolve(roomId);
  });

  socket.on("withdraw_bid", async () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.blockedUsers.add(socket.id);
    room.withdrawnUsers.add(socket.id);

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
    room.passedUsers.add(socket.id);
    room.bidHistory.push({
      amount: room.currentBid,
      by: socket.data.username,
      ts: Date.now(),
      note: "pass",
    });

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
      maybeAutoResolve(roomId);
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
    io.to(resolvedRoom).emit("chat_message", {
      user: socket.data.username,
      text: msg,
      ts: Date.now(),
    });
  });

  socket.on("submit_playing11", (payload) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    
    // Check if 3 minutes (180,000 ms) have passed since selection started
    const waitPeriod = 3 * 60 * 1000;
    const elapsed = Date.now() - (room.selectionStartTime || 0);
    if (elapsed < waitPeriod) {
      const remainingWait = Math.ceil((waitPeriod - elapsed) / 1000);
      socket.emit("playing11_error", { 
        reason: `Please wait ${remainingWait}s more to finalize your squad. Use this time to strategize!` 
      });
      return;
    }

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
    room.playing11.set(socket.id, { ...evalResult, playerIds: ids, username: socket.data.username });

    if (room.dbId && room.users.get(socket.id)?.userId) {
      const uid = room.users.get(socket.id).userId;
      persistPlaying11(room.dbId, uid, ids, evalResult.score)
        .catch((err) => console.error("Failed to persist playing11", formatDbError(err)));
    }

    const active = activeSockets(room);
    const submissions = room.playing11.size;
    if (submissions >= active.length) {
      const results = Array.from(room.playing11.values()).sort((a, b) => b.score - a.score);
      const winnerName = results[0]?.username || "No winner";
      io.to(roomId).emit("playing11_results", { winner: winnerName, results });
    } else {
      socket.emit("playing11_ack", { ok: true, pending: active.length - submissions });
    }
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    // Start a 120-second grace period before removing the user
    const timeoutId = setTimeout(() => {
      if (room.users.has(socket.id)) {
        room.users.delete(socket.id);
        room.disconnectTimeouts.delete(socket.id);
        broadcastPlayers(roomId);
        console.log(`User ${socket.data.username} removed from room ${roomId} after grace period`);
      }
    }, 120000); // 120 seconds

    room.disconnectTimeouts.set(socket.id, timeoutId);
    
    io.to(roomId).emit("user_left_voice", { socketId: socket.id });
  });
});

async function bootstrap() {
  const db = getDatabaseSummary();
  try {
    await verifyDatabaseConnection();
    console.log(`Supabase Postgres connected at ${db.host}:${db.port}/${db.database}`);
  } catch (err) {
    console.warn(
      `Supabase Postgres unavailable at ${db.host}:${db.port}/${db.database}; starting with fallback data where supported: ${formatDbError(err)}`
    );
  }

  playersMaster = await loadPlayers();
  teamsMaster = await loadTeams();
  const port = process.env.PORT || 5000;
  server.listen(port, () => {
    console.log(`Auction server listening on ${port}`);
  });
}

bootstrap();
