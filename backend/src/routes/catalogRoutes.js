import express from "express";
import { loadPlayers } from "../playerStore.js";
import { loadTeams } from "../teamStore.js";

const router = express.Router();

router.get("/health", (_req, res) => res.json({ ok: true }));

router.get("/players", async (_req, res) => {
  const players = await loadPlayers();
  res.json(players);
});

router.get("/teams", async (_req, res) => {
  const teams = await loadTeams();
  res.json(teams);
});

export default router;
