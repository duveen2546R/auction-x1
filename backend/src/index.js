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
    bidHistory: [],
    passedUsers: new Set(),
    blockedUsers: new Set(),
    playing11: new Map(),
    disqualified: new Set(),
    finalizingBid: false,
  };
}

function activeSockets(room) {
  return Array.from(room.users.keys()).filter((id) => !room.blockedUsers.has(id));
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
    completed: Math.max(0, room.idx - 1),
    next: room.playersQueue.slice(room.idx, room.idx + 3),
  };
}

function getHighestBidderName(room) {
  return room.users.get(room.highestBidder || "")?.username || room.highestBidderName || null;
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
    let initialBudget = 100;
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
    budget: Number(latestRow.budget ?? 100),
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
  const players = Array.from(room.users.values()).map((u) => ({
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
    const totalDuration = 13000;
    const remainingMs = Math.max(0, totalDuration - idleMs);

    io.to(roomId).emit("timer_tick", { 
      remainingMs, 
      totalMs: totalDuration,
      percent: (remainingMs / totalDuration) * 100 
    });

    if (!room.warnedOnce && idleMs >= 7000) {
      room.warnedOnce = true;
      io.to(roomId).emit("bid_warning", { stage: "once", by: getHighestBidderName(room) || "No bids" });
    } else if (room.warnedOnce && !room.warnedTwice && idleMs >= 10000) {
      room.warnedTwice = true;
      io.to(roomId).emit("bid_warning", { stage: "twice", by: getHighestBidderName(room) || "No bids" });
    } else if (room.warnedTwice && idleMs >= 13000) {
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

  // If every active player has either passed or is currently the high bidder,
  // no more bidding is possible. Finalize immediately.
  const noMoreBidsPossible = activeIds.every(id => 
    id === room.highestBidder || room.passedUsers.has(id)
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

  const balanceBonus = 100;
  const score = battingTotal * 0.45 + bowlingTotal * 0.45 + balanceBonus * 0.1;

  return {
    ok: true,
    score,
    breakdown: { battingTotal, bowlingTotal, balanceBonus, bats, bowls, wks, ars },
  };
}

async function startNextPlayer(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }

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
    setTimeout(() => {
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
      emitQueueUpdate(roomId);
      startTimer(roomId);
      maybeAutoResolve(roomId);
    }, 4000); // 4 second delay for the set transition animation
    return;
  }

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
  emitQueueUpdate(roomId);
  startTimer(roomId);
  maybeAutoResolve(roomId);
}

async function finalizeBid(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.currentPlayer || room.finalizingBid) return;

  room.finalizingBid = true;
  const soldPlayer = { ...room.currentPlayer };
  const soldPrice = Number(room.currentBid || soldPlayer.base_price || 0);

  const [winnerSocketId, liveWinner] = getHighestBidderEntry(room);
  const winnerUserId = liveWinner?.userId || room.highestBidderUserId || null;
  const winnerName = liveWinner?.username || room.highestBidderName || null;

  try {
    if (winnerUserId || liveWinner) {
      let currentBudget = Number(liveWinner?.budget ?? 100);
      
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
    setTimeout(() => startNextPlayer(roomId), 1500);
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
    const bats = roster.filter((p) => p.role?.includes("bat")).length;
    const bowls = roster.filter((p) => p.role?.includes("bowl")).length;
    const wks = roster.filter((p) => p.role?.includes("keep")).length;
    const ars = roster.filter((p) => p.role?.includes("all")).length;
    const overseas = roster.filter((p) => (p.country || "").toLowerCase() !== "india").length;
    const locals = total - overseas;

    const feasible =
      total >= 11 &&
      bats >= 3 &&
      bowls >= 2 &&
      wks >= 1 &&
      locals >= 7; // to satisfy max 4 overseas (total 11 - max 4 OS = min 7 locals)
    // Note: ars is already limited by the 4-max rule during selection, 
    // and here we check if pure roles meet the minimum requirements.

    if (!feasible) disqualified.add(sid);
  });
  room.disqualified = disqualified;
  const dqNames = Array.from(disqualified).map((sid) => room.users.get(sid)?.username).filter(Boolean);

  room.selectDeadline = Date.now() + 2 * 60 * 1000; // 2 minutes
  setTimeout(() => autoFinalizePlaying11(roomId), 2 * 60 * 1000 + 500);

  io.to(roomId).emit("auction_complete", {
    stage: "select11",
    scores,
    disqualified: dqNames,
    deadline: room.selectDeadline,
  });
}

function buildAutoLineup(team) {
  const lineup = [];
  const bats = team.filter((p) => (p.role || "").toLowerCase().includes("bat") && !(p.role || "").toLowerCase().includes("all"));
  const bowls = team.filter((p) => (p.role || "").toLowerCase().includes("bowl") && !(p.role || "").toLowerCase().includes("all"));
  const wks = team.filter((p) => (p.role || "").toLowerCase().includes("keep"));
  const ars = team.filter((p) => (p.role || "").toLowerCase().includes("all"));

  const byScore = (arr) =>
    arr.slice().sort((a, b) => (Number(b.batting_rating ?? b.rating ?? 0) + Number(b.bowling_rating ?? b.rating ?? 0)) -
      (Number(a.batting_rating ?? a.rating ?? 0) + Number(a.bowling_rating ?? a.rating ?? 0)));

  const overseas = (p) => (p.country || "").toLowerCase() !== "india";
  const pushWithCap = (p) => {
    const osCount = lineup.filter(overseas).length;
    if (overseas(p) && osCount >= 4) return false;
    lineup.push(p);
    return true;
  };

  // 1 wk
  for (const p of byScore(wks)) { if (pushWithCap(p)) break; }
  if (!lineup.some((p) => (p.role || "").toLowerCase().includes("keep"))) return null;

  // 1-3 AR
  for (const p of byScore(ars)) {
    if (lineup.filter((x) => (x.role || "").toLowerCase().includes("all")).length >= 3) break;
    pushWithCap(p);
  }
  if (lineup.filter((x) => (x.role || "").toLowerCase().includes("all")).length < 1) return null;

  // Fill bats to 4
  for (const p of byScore(bats)) {
    if (lineup.length >= 11) break;
    const batCount = lineup.filter((x) => (x.role || "").toLowerCase().includes("bat") || (x.role || "").toLowerCase().includes("all")).length;
    if (batCount >= 4) break;
    pushWithCap(p);
  }

  // Fill bowls to 3
  for (const p of byScore(bowls)) {
    if (lineup.length >= 11) break;
    const bowlCount = lineup.filter((x) => (x.role || "").toLowerCase().includes("bowl") || (x.role || "").toLowerCase().includes("all")).length;
    if (bowlCount >= 3) break;
    pushWithCap(p);
  }

  // Fill remaining best overall
  const remaining = byScore(team.filter((p) => !lineup.includes(p)));
  for (const p of remaining) {
    if (lineup.length >= 11) break;
    pushWithCap(p);
  }

  if (lineup.length !== 11) return null;
  const val = evaluatePlaying11({ users: new Map([["tmp", { team: lineup }]]) }, "tmp", lineup.map((p) => p.id));
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
    const winnerName = results[0]?.username || "No winner";
    const dqNames = Array.from(disqualified).map((sid) => room.users.get(sid)?.username).filter(Boolean);
    io.to(roomId).emit("playing11_results", { winner: winnerName, results, disqualified: dqNames });
    room.status = "finished_finalized";
  }
}

function handleBid(socket, amount) {
  const roomId = socket.data.roomId;
  const room = rooms.get(roomId);
  if (!room || !room.currentPlayer) return;
  if (room.blockedUsers.has(socket.id)) return;
  if (room.passedUsers.has(socket.id)) return;
  if (room.highestBidder === socket.id) return; // prevent consecutive self-bids

  const numericBid = Math.round(Number(amount) * 100) / 100;
  const currentBidRounded = Math.round(room.currentBid * 100) / 100;
  const step = currentBidRounded < 10 ? 0.2 : 0.5;
  
  // If no one has bid yet, allow bidding the base price (room.currentBid)
  const minRequired = room.highestBidder ? (currentBidRounded + step) : currentBidRounded;
  
  if (Number.isNaN(numericBid) || numericBid < minRequired - 1e-9) return;

  const user = room.users.get(socket.id);
  if (user && numericBid > (user.budget ?? 100)) {
    socket.emit("bid_error", { reason: "Insufficient budget" });
    return;
  }

  room.currentBid = numericBid;
  room.highestBidder = socket.id;
  room.highestBidderUserId = user?.userId || null;
  room.highestBidderName = socket.data.username;
  room.lastBidAt = Date.now();
  room.warnedOnce = false;
  room.warnedTwice = false;
  room.passedUsers.delete(socket.id);
  room.bidHistory.push({
    amount: room.currentBid,
    by: socket.data.username,
    ts: Date.now(),
  });

  io.to(roomId).emit("bid_update", {
    amount: room.currentBid,
    by: socket.data.username,
    history: room.bidHistory.slice(-10),
    step: room.currentBid < 10 ? 0.2 : 0.5,
  });
  maybeAutoResolve(roomId);

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
    let budget = 100;
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

      if (cleanTeam) {
        const [teamRow] = await pool.query("SELECT id FROM teams WHERE name = ? LIMIT 1", [cleanTeam]);
        if (teamRow.length) {
          teamId = teamRow[0].id;
        }
      }

      const roomPlayerRow = await ensureRoomPlayerRow(roomDbId, userId, cleanTeam, teamId);
      budget = Number(roomPlayerRow.budget ?? 100);
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
    socket.data.userId = userId;
    const [existingSocketId, existingUser] = findRoomUser(room, userId, cleanName);
    if (existingSocketId) {
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
    const mergedBudget = budget ?? existingUser?.budget ?? 100;
    const mergedUser = {
      username: cleanName,
      team,
      score: calculateScore(team),
      budget: mergedBudget,
      userId,
      teamName: cleanTeam || existingUser?.teamName || null,
    };
    room.users.set(socket.id, mergedUser);
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

  socket.on("start_auction", (roomId) => {
    const resolvedRoom = roomId || socket.data.roomId;
    const room = getRoom(resolvedRoom);
    if (room.status === "running") return;
    io.to(resolvedRoom).emit("start_auction");
    setTimeout(() => startNextPlayer(resolvedRoom), 800);
  });

  socket.on("place_bid", (amount) => handleBid(socket, amount));

  socket.on("withdraw_bid", async () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.blockedUsers.add(socket.id);

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
    room.users.delete(socket.id);
    broadcastPlayers(roomId);
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
