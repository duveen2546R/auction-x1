import assert from "node:assert/strict";
import test from "node:test";
import { organizePlayersIntoSets } from "../src/services/playerQueue.js";

test("player queue groups every player once", () => {
  const players = [
    { id: 1, role: "batsman", country: "India" },
    { id: 2, role: "bowler", country: "Australia" },
    { id: 3, role: "wicketkeeper", country: "India" },
    { id: 4, role: "allrounder", country: "South Africa" },
    { id: 5, role: "unknown", country: "India" },
  ];

  const queue = organizePlayersIntoSets(players, () => 0.5);

  assert.equal(queue.length, players.length);
  assert.deepEqual(
    new Set(queue.map((player) => player.id)),
    new Set(players.map((player) => player.id))
  );
  assert.equal(queue.find((player) => player.id === 1).setName, "Indian Batsmen");
  assert.equal(queue.find((player) => player.id === 2).setName, "Overseas Bowlers");
  assert.equal(queue.find((player) => player.id === 3).setName, "Indian Wicketkeepers");
  assert.equal(queue.find((player) => player.id === 4).setName, "Overseas All-Rounders");
  assert.equal(queue.find((player) => player.id === 5).setName, "Other Players");
});
