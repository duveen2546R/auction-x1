function normalizeIdentityValue(value) {
  const cleanValue = String(value || "").trim().toLowerCase();
  return cleanValue || null;
}

function getStableIdentityKeyFromParts(userId, teamName, username) {
  const numericUserId = Number(userId);
  if (Number.isInteger(numericUserId) && numericUserId > 0) {
    return `user:${numericUserId}`;
  }

  const normalizedTeamName = normalizeIdentityValue(teamName);
  if (normalizedTeamName) {
    return `team:${normalizedTeamName}`;
  }

  const normalizedUsername = normalizeIdentityValue(username);
  if (normalizedUsername) {
    return `username:${normalizedUsername}`;
  }

  return null;
}

function normalizePlayerEntry(player = {}) {
  return {
    id: Number(player.id || 0) || null,
    name: player.name || null,
    role: player.role || null,
    country: player.country || null,
    price:
      typeof player.price === "number" || typeof player.price === "string"
        ? Number(player.price)
        : 0,
  };
}

function mergePlayers(primary = [], secondary = []) {
  const merged = [];
  const seen = new Set();

  for (const player of [...primary, ...secondary]) {
    const normalizedPlayer = normalizePlayerEntry(player);
    const playerKey = `${normalizedPlayer.id || normalizedPlayer.name || "player"}:${normalizedPlayer.price}`;
    if (seen.has(playerKey)) continue;
    seen.add(playerKey);
    merged.push(normalizedPlayer);
  }

  return merged;
}

function mergePurseEntry(existing = {}, incoming = {}) {
  return {
    userId: Number(existing.userId || incoming.userId || 0) || null,
    username: existing.username || incoming.username || null,
    teamName: existing.teamName || incoming.teamName || null,
    budget:
      typeof existing.budget === "number"
        ? existing.budget
        : typeof incoming.budget === "number"
          ? incoming.budget
          : Number(existing.budget ?? incoming.budget ?? 0),
    players: mergePlayers(existing.players || [], incoming.players || []),
  };
}

function toComparableLabel(entry = {}) {
  return String(entry.teamName || entry.username || "").toLowerCase();
}

export function mergePurseEntries(persistedEntries = [], runtimeEntries = []) {
  const mergedByIdentity = new Map();

  const upsertEntry = (entry = {}) => {
    const identityKey =
      getStableIdentityKeyFromParts(entry.userId, entry.teamName, entry.username) ||
      `anon:${mergedByIdentity.size}`;
    const existingEntry = mergedByIdentity.get(identityKey);
    mergedByIdentity.set(identityKey, mergePurseEntry(existingEntry, entry));
  };

  for (const entry of persistedEntries) {
    upsertEntry(entry);
  }

  for (const entry of runtimeEntries) {
    upsertEntry(entry);
  }

  return Array.from(mergedByIdentity.values()).sort((left, right) =>
    toComparableLabel(left).localeCompare(toComparableLabel(right))
  );
}
