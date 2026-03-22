# IPL Auction Game (React + Node + Supabase Postgres)

A real-time multiplayer IPL-style auction game. Players join a room, bid on cricketers with live updates over Socket.IO, and the winner is the team with the highest total player rating.

## Stack
- Frontend: React 19 (Vite), Socket.IO client.
- Backend: Node/Express + Socket.IO server, Supabase Postgres (fallback in-memory data if DB unavailable).

## Quick start
1) **Backend**
   ```bash
   cd backend
   cp .env.example .env  # update DB creds
   npm install
   # create the tables inside Supabase using backend/db/schema.sql
   npm run dev
   ```
   Server listens on `PORT` (default 5000).

2) **Frontend**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
   Visit the Vite dev URL (default http://localhost:5173).

## How to play
- Create a room on the home screen, share the 6-digit code, others tap **Join Room** and enter the code.
- When at least 2 players are in the lobby, click **Start Auction**. All clients switch to the auction view.
- Each player is announced with a base price and rating. Place bids; the highest bid when the timer hits zero wins the player.
- The game cycles through the player list (from the Supabase `cricketers` table). After the final player, the server computes team ratings and broadcasts the winner + scoreboard.

## Data model (Supabase Postgres)
- Tables: `users`, `rooms`, `room_players` (with team_name/team_id), `cricketers`, `bids`, `team_players`, `auction_state`, `teams`.
- `cricketers` is pre-seeded; add your own franchises into `teams` (or use `/teams` fallback list in code).
- Runtime room state lives in memory for speed; bids, winners, budgets persist to Supabase Postgres.

## UX
- Home: modern hero; pick username + franchise from `/teams`, create or join with a 6-digit code.
- Lobby: shows players with their chosen teams; start when 2+ players.
- Auction: bid, Withdraw (if top bidder), Pass (when everyone passes the player is unsold or awarded to current high bid). Idle warnings: going once (7s), twice (10s), auto-sold (~13s) if no new bids.

## Notes
- Backend automatically falls back to a built-in player list if the database is unreachable, so development works even before Supabase is set up.
- Environment variable `VITE_API_URL` (frontend) / `PORT` + `FRONTEND_ORIGIN` (backend) let you run across hosts.
