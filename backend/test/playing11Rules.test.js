import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAutoLineup,
  canFormPlaying11,
  evaluatePlaying11,
} from "../src/services/playing11Rules.js";

const squad = [
  { id: 1, name: "Bat 1", role: "batsman", country: "India", batting_rating: 90 },
  { id: 2, name: "Bat 2", role: "batsman", country: "India", batting_rating: 88 },
  { id: 3, name: "Bat 3", role: "batsman", country: "Australia", batting_rating: 86 },
  { id: 4, name: "Bowl 1", role: "bowler", country: "India", bowling_rating: 91 },
  { id: 5, name: "Bowl 2", role: "bowler", country: "India", bowling_rating: 89 },
  { id: 6, name: "Keeper", role: "wicketkeeper", country: "India", batting_rating: 84 },
  { id: 7, name: "AR 1", role: "allrounder", country: "India", rating: 85 },
  { id: 8, name: "AR 2", role: "allrounder", country: "England", rating: 83 },
  { id: 9, name: "Bat 4", role: "batsman", country: "India", batting_rating: 82 },
  { id: 10, name: "Bowl 3", role: "bowler", country: "New Zealand", bowling_rating: 81 },
  { id: 11, name: "Bat 5", role: "batsman", country: "India", batting_rating: 80 },
  { id: 12, name: "Reserve", role: "bowler", country: "India", bowling_rating: 78 },
];

test("valid Playing XI is accepted and scored", () => {
  const result = evaluatePlaying11(
    { team: squad, budget: 50 },
    squad.slice(0, 11).map((player) => player.id)
  );

  assert.equal(result.ok, true);
  assert.equal(result.playerNames.length, 11);
  assert.ok(result.score > 0);
});

test("auto lineup preserves a compatible locked pick", () => {
  const lineup = buildAutoLineup(squad, [1], () => 0.5);

  assert.equal(lineup.length, 11);
  assert.ok(lineup.some((player) => player.id === 1));
  assert.equal(
    evaluatePlaying11({ team: squad, budget: 50 }, lineup.map((player) => player.id)).ok,
    true
  );
});

test("eligibility rejects squads that are too small", () => {
  assert.equal(canFormPlaying11(squad), true);
  assert.equal(canFormPlaying11(squad.slice(0, 10)), false);
});
