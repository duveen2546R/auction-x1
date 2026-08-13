export function normalizePlayerIdList(lineup) {
  if (!Array.isArray(lineup)) return [];
  return lineup
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

export function calculateScore(team = []) {
  return team.reduce((sum, player) => sum + Number(player.rating || 0), 0);
}

function getLineupStats(lineup) {
  let bats = 0;
  let bowls = 0;
  let wks = 0;
  let ars = 0;
  let overseas = 0;
  let battingTotal = 0;
  let bowlingTotal = 0;

  for (const player of lineup) {
    const role = (player.role || "").toLowerCase();
    const battingRating = Number(player.batting_rating ?? player.rating ?? 0);
    const bowlingRating = Number(player.bowling_rating ?? player.rating ?? 0);
    const isOverseas = (player.country || "").toLowerCase() !== "india";
    const isAllRounder = role.includes("all");
    const isBatter = role.includes("bat") || role.includes("open") || role.includes("middle");
    const isBowler = role.includes("bowl") || role.includes("pace") || role.includes("spin");
    const isWicketkeeper = role.includes("keep") || role.includes("wk");

    if (isOverseas) overseas += 1;
    if (isAllRounder) {
      ars += 1;
      battingTotal += battingRating;
      bowlingTotal += bowlingRating;
    } else {
      if (isBatter) {
        bats += 1;
        battingTotal += battingRating;
      }
      if (isBowler) {
        bowls += 1;
        bowlingTotal += bowlingRating;
      }
      if (isWicketkeeper) {
        wks += 1;
        bats += 1;
        battingTotal += battingRating;
      }
    }
  }

  return { bats, bowls, wks, ars, overseas, battingTotal, bowlingTotal };
}

export function canFormPlaying11(team) {
  const roster = Array.isArray(team) ? team.filter(Boolean) : [];
  const { bats, bowls, wks, overseas } = getLineupStats(roster);
  const locals = roster.length - overseas;

  return roster.length >= 11 && bats >= 3 && bowls >= 2 && wks >= 1 && locals >= 7;
}

export function evaluatePlaying11(user, playerIds) {
  if (!user) return { ok: false, reason: "user missing" };
  if (playerIds.length !== 11) {
    return { ok: false, reason: "Must pick exactly 11 players" };
  }

  const owned = new Map((user.team || []).map((player) => [Number(player.id), player]));
  const lineup = [];
  for (const rawId of playerIds) {
    const player = owned.get(Number(rawId));
    if (!player) return { ok: false, reason: "Contains player you do not own" };
    lineup.push(player);
  }

  const stats = getLineupStats(lineup);
  if (stats.bats < 3) return { ok: false, reason: "Need at least 3 batsmen" };
  if (stats.bowls < 2) return { ok: false, reason: "Need at least 2 bowlers" };
  if (stats.wks < 1) return { ok: false, reason: "Need at least 1 wicketkeeper" };
  if (stats.ars > 4) return { ok: false, reason: "Max 4 all-rounders" };
  if (stats.overseas > 4) return { ok: false, reason: "Max 4 overseas players" };

  const balanceBonus = Number(user.budget || 0);
  const score = (stats.battingTotal + stats.bowlingTotal) * 0.4 + balanceBonus * 0.2;

  return {
    ok: true,
    score,
    breakdown: {
      battingTotal: stats.battingTotal,
      bowlingTotal: stats.bowlingTotal,
      balanceBonus,
      bats: stats.bats,
      bowls: stats.bowls,
      wks: stats.wks,
      ars: stats.ars,
    },
    playerNames: lineup.map((player) => player.name),
  };
}

export function buildAutoLineup(team, lockedPlayerIds = [], random = Math.random) {
  const normalizedTeam = Array.isArray(team) ? team.filter(Boolean) : [];
  const lockedIds = Array.from(new Set(normalizePlayerIdList(lockedPlayerIds)));
  const teamById = new Map(normalizedTeam.map((player) => [Number(player.id), player]));
  const lockedLineup = lockedIds.map((playerId) => teamById.get(playerId)).filter(Boolean);

  const isValid = (lineup) => {
    if (lineup.length !== 11) return false;
    const { bats, bowls, wks, ars, overseas } = getLineupStats(lineup);
    return bats >= 3 && bowls >= 2 && wks >= 1 && ars <= 4 && overseas <= 4;
  };

  const canStillComplete = (seedLineup) => {
    if (seedLineup.length > 11) return false;

    const seedIds = new Set(seedLineup.map((player) => Number(player.id)));
    const remainingPool = normalizedTeam.filter(
      (player) => !seedIds.has(Number(player.id))
    );
    if (seedLineup.length + remainingPool.length < 11) return false;

    const seedStats = getLineupStats(seedLineup);
    if (seedStats.ars > 4 || seedStats.overseas > 4) return false;

    const remainingStats = getLineupStats(remainingPool);
    if (seedStats.bats + remainingStats.bats < 3) return false;
    if (seedStats.bowls + remainingStats.bowls < 2) return false;
    if (seedStats.wks + remainingStats.wks < 1) return false;

    return true;
  };

  const shuffle = (array) => {
    const shuffled = [...array];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
  };

  const tryCompleteLineup = (seedLineup) => {
    if (!canStillComplete(seedLineup)) return null;

    const seedIds = new Set(seedLineup.map((player) => Number(player.id)));
    const remainingPool = normalizedTeam.filter(
      (player) => !seedIds.has(Number(player.id))
    );

    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const lineup = [...seedLineup];
      const ownedIds = new Set(seedIds);

      for (const player of shuffle(remainingPool)) {
        if (lineup.length >= 11) break;
        if (!ownedIds.has(Number(player.id))) {
          lineup.push(player);
          ownedIds.add(Number(player.id));
        }
      }

      if (isValid(lineup)) return lineup;
    }

    return null;
  };

  if (lockedLineup.length > 11) return tryCompleteLineup([]);
  const strictLockedLineup = tryCompleteLineup(lockedLineup);
  if (strictLockedLineup) return strictLockedLineup;

  if (lockedLineup.length > 0) {
    const subsetCandidates = [];
    const totalMasks = 1 << lockedLineup.length;

    for (let mask = 1; mask < totalMasks; mask += 1) {
      const subset = [];
      for (let index = 0; index < lockedLineup.length; index += 1) {
        if (mask & (1 << index)) subset.push(lockedLineup[index]);
      }
      subsetCandidates.push(subset);
    }

    subsetCandidates.sort((left, right) => right.length - left.length);
    for (const subset of subsetCandidates) {
      const candidateLineup = tryCompleteLineup(subset);
      if (candidateLineup) return candidateLineup;
    }
  }

  return tryCompleteLineup([]);
}
