export function shufflePlayers(players, random = Math.random) {
  return players
    .map((item) => ({ ...item, sort: random() }))
    .sort((left, right) => left.sort - right.sort)
    .map(({ sort: _sort, ...player }) => player);
}

export function organizePlayersIntoSets(players, random = Math.random) {
  const isIndian = (player) => (player.country || "").toLowerCase() === "india";
  const getRole = (player) => (player.role || "").toLowerCase();

  const isWicketkeeper = (player) =>
    getRole(player).includes("keep") || getRole(player).includes("wk");
  const isAllRounder = (player) => getRole(player).includes("all");
  const isBatter = (player) =>
    getRole(player).includes("bat") ||
    getRole(player).includes("open") ||
    getRole(player).includes("middle");
  const isBowler = (player) =>
    getRole(player).includes("bowl") ||
    getRole(player).includes("pace") ||
    getRole(player).includes("spin");

  const categories = [
    {
      name: "Indian Batsmen",
      filter: (player) =>
        isIndian(player) && isBatter(player) && !isAllRounder(player) && !isWicketkeeper(player),
    },
    {
      name: "Overseas Batsmen",
      filter: (player) =>
        !isIndian(player) && isBatter(player) && !isAllRounder(player) && !isWicketkeeper(player),
    },
    { name: "Indian All-Rounders", filter: (player) => isIndian(player) && isAllRounder(player) },
    { name: "Overseas All-Rounders", filter: (player) => !isIndian(player) && isAllRounder(player) },
    {
      name: "Indian Bowlers",
      filter: (player) => isIndian(player) && isBowler(player) && !isAllRounder(player),
    },
    {
      name: "Overseas Bowlers",
      filter: (player) => !isIndian(player) && isBowler(player) && !isAllRounder(player),
    },
    {
      name: "Indian Wicketkeepers",
      filter: (player) => isIndian(player) && isWicketkeeper(player),
    },
    {
      name: "Overseas Wicketkeepers",
      filter: (player) => !isIndian(player) && isWicketkeeper(player),
    },
  ];

  const processedIds = new Set();
  const orderedQueue = [];

  for (const category of categories) {
    const setPlayers = players
      .filter(category.filter)
      .filter((player) => !processedIds.has(player.id));
    orderedQueue.push(
      ...shufflePlayers(setPlayers, random).map((player) => ({
        ...player,
        setName: category.name,
      }))
    );
    setPlayers.forEach((player) => processedIds.add(player.id));
  }

  const remaining = players.filter((player) => !processedIds.has(player.id));
  orderedQueue.push(
    ...shufflePlayers(remaining, random).map((player) => ({
      ...player,
      setName: "Other Players",
    }))
  );

  return orderedQueue;
}
