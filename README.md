# AuctionXI

AuctionXI is a real-time cricket auction platform for running IPL-style franchise auctions in the browser. It combines live bidding, public/private room management, voice chat, persistent history, Playing XI selection, and Supabase/PostgreSQL-backed recovery into a single full-stack app.

## Overview

The app is built as:

- `frontend/`: React + Vite client
- `backend/`: Express + Socket.IO server
- `backend/db/schema.sql`: PostgreSQL schema for users, rooms, bids, teams, squads, and Playing XI results

At a high level, the flow is:

1. A logged-in user creates a room.
2. Other users join the lobby.
3. The room creator starts the auction.
4. Teams bid on players in real time.
5. After the auction, each user submits a Playing XI.
6. The leaderboard is calculated and the session is saved to history.

## Current Feature Set

- Real-time multi-user auction with Socket.IO
- Public and private rooms
- Public rooms visible from the home screen while still in the lobby
- Public rooms automatically hidden once the auction starts
- Only the room creator can start the auction
- Room creation restricted to authenticated users
- Login and registration with password hashing
- Signed session tokens using HMAC-based JWT-style auth
- Persistent room sessions, including replay support for the same room code
- Recent auction history per user
- Room leaderboard history
- Saved Playing XI history per session
- Team purse tracking and sold/unsold market inventory
- Structured player pools such as Indian Batsmen, Overseas Bowlers, and more
- Voice chat during the auction
- Reconnect and recovery flow for live rooms
- Automatic room closure after inactivity
- Automatic Playing XI fallback selection for users who do not submit before timeout
- DB fallback for player/team reads when PostgreSQL is temporarily unavailable

## Auction Rules

### Bidding

- Base bid starts from the player's `base_price`
- Bid increment is:
  - `0.2` for bids under `10`
  - `0.5` for bids `10` and above
- Each new bid extends the timer, capped at 15 seconds
- Users can pass on a player
- Users can vote to skip the entire current pool
- Users can withdraw from the auction and remain only as a viewer

### Auction End

The auction ends when no more players remain in the queue. The app then moves to the Playing XI selection phase.

### Playing XI Rules

A valid XI must:

- contain exactly 11 players
- include at least 3 batsmen
- include at least 2 bowlers
- include at least 1 wicketkeeper
- include at most 4 all-rounders
- include at most 4 overseas players

If a user has a squad that cannot possibly satisfy these rules, they are marked disqualified for the XI stage.

### Playing XI Timeout

- Users can manually lock in their XI during the 5-minute selection window
- If all eligible users submit before the deadline, results can finalize early
- If the deadline ends and a user has not submitted, the server generates a random valid XI for that user
- The auto-generated XI is saved and reflected in the leaderboard

## Room and Session Behavior

### Public vs Private Rooms

- `public` rooms are shown on the home page while the room is still waiting in the lobby
- `private` rooms are join-by-code only
- once an auction starts, the room is no longer shown in the public lobby list

### Room Ownership

- only the room creator can start the auction
- room creation requires authentication
- joining an already-existing room is still allowed without creating a new session

### Session History

The same room code can be used across multiple auction runs. Each run is stored as its own session using `session_number`, so history no longer overwrites the previous auction for that room code.

### Reconnects

The backend keeps disconnected players in the room for a grace period and attempts to restore live auction state when they reconnect. The auction page also resyncs if it stops hearing live room events for a few seconds.

### Auto-Closure

Rooms are automatically closed when:

- the result countdown completes
- the room has been inactive in auction/result flow for 30 minutes
- the room remains empty long enough to be cleaned up

## Authentication

Authentication is custom and lightweight:

- usernames are stored in `users`
- passwords are stored as `scrypt` hashes in `password_hash`
- the backend signs auth tokens using `JWT_SECRET`
- the frontend stores the token in `localStorage`

Available auth routes:

- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`

## REST API Summary

Core backend routes include:

- `GET /health`
- `GET /players`
- `GET /teams`
- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`
- `GET /rooms/:roomId/players-status`
- `GET /rooms/:roomId/purses`
- `GET /user/history`

Notes:

- room history and leaderboard data are tied to authenticated users
- `players-status` returns sold, remaining, unsold, and current user squad data
- `purses` returns room budgets and purchased players by team

## Socket Events Summary

Main live auction events include:

- `join_room`
- `join_ack`
- `join_error`
- `start_auction`
- `start_auction_denied`
- `new_player`
- `bid_update`
- `timer_tick`
- `bid_warning`
- `place_bid`
- `pass_player`
- `skip_pool`
- `skip_update`
- `pool_skipped`
- `withdraw_bid`
- `player_won`
- `auction_complete`
- `submit_playing11`
- `playing11_ack`
- `playing11_error`
- `playing11_results`
- `room_closed`

Voice chat events include:

- `voice_join`
- `voice_signal`
- `voice_toggle_mic`
- `user_joined_voice`
- `user_left_voice`

## Tech Stack

### Frontend

- React 19
- React Router
- Vite
- Socket.IO client
- Tailwind CSS

### Backend

- Node.js
- Express
- Socket.IO
- PostgreSQL via `pg`
- Native `crypto` for auth token signing and password hashing

### Data

- Supabase/PostgreSQL for persistent storage
- bundled fallback player/team data when DB reads fail

## Project Structure

```text
auction-x1-main/
├── backend/
│   ├── db/
│   │   └── schema.sql
│   ├── src/
│   │   ├── auth.js
│   │   ├── db.js
│   │   ├── env.js
│   │   ├── index.js
│   │   ├── playerStore.js
│   │   ├── routes.js
│   │   ├── roomSessions.js
│   │   ├── runtimeRooms.js
│   │   ├── teamStore.js
│   │   └── data/
│   └── package.json
├── frontend/
│   ├── public/
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── session.js
│   │   └── socket.js
│   └── package.json
└── README.md
```

## Pages

### Frontend Routes

- `/` - home screen, room creation, public room browsing
- `/auth` - login and register
- `/history` - recent auctions, leaderboard, and saved Playing XI
- `/lobby/:roomId` - pre-auction room lobby
- `/auction/:roomId` - live auction screen
- `/result` - Playing XI and final leaderboard screen

## Environment Variables

### Backend `.env`

Example:

```env
PORT=5001
FRONTEND_ORIGIN=http://localhost:5173
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@YOUR_SUPABASE_HOST:6543/postgres
JWT_SECRET=replace-this-with-a-long-random-secret
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@example.com
SMTP_PASS=your-app-password
MAIL_FROM=AuctionXI <your-email@example.com>
SMTP_FAMILY=4
```

Required values:

- `PORT`: backend server port
- `FRONTEND_ORIGIN`: allowed frontend origin for CORS
- `DATABASE_URL`: Supabase/PostgreSQL connection string
- `JWT_SECRET`: secret used to sign auth tokens

Optional mail values:

- `SMTP_HOST`: SMTP server hostname
- `SMTP_PORT`: SMTP server port, usually `587` or `465`
- `SMTP_SECURE`: set to `true` for implicit TLS, usually with port `465`
- `SMTP_USER`: SMTP account username
- `SMTP_PASS`: SMTP account password or app password
- `MAIL_FROM`: sender shown in outgoing emails
- `SMTP_FAMILY`: IP family used for SMTP DNS resolution. Keep this at `4` on Render to avoid IPv6 `ENETUNREACH` errors, or set `0` to use the platform default

### Frontend `.env`

Example:

```env
VITE_API_URL=http://localhost:5001
```

## Local Development

### 1. Install dependencies

Backend:

```bash
cd backend
npm install
```

Frontend:

```bash
cd frontend
npm install
```

### 2. Set up the database

Run the SQL in:

```text
backend/db/schema.sql
```

This creates:

- `users`
- `rooms`
- `teams`
- `room_players`
- `cricketers`
- `bids`
- `team_players`
- `unsold_players`
- `auction_state`
- `playing11`

If your database was created before auth support was added, make sure `users.password_hash` exists:

```sql
ALTER TABLE users
ADD COLUMN IF NOT EXISTS password_hash TEXT;
```

### 3. Start the backend

```bash
cd backend
npm run dev
```

### 4. Start the frontend

```bash
cd frontend
npm run dev
```

The local setup used in this project is usually:

- frontend: `http://localhost:5173`
- backend: `http://localhost:5001`

## Database Notes

### Room Sessions

The `rooms` table stores each auction run as a separate session:

- `room_code` identifies the visible room code
- `session_number` increments for each new run of that room code
- history uses these session rows to keep old auctions separate

### Auction State Recovery

The server persists runtime recovery data in `auction_state`, including:

- queue index
- room status
- current bid
- highest bidder identity
- timer references
- XI selection deadline data

### Team and History Data

- purchased players are stored in `team_players`
- purse state is stored in `room_players`
- unsold players are stored in `unsold_players`
- final XIs and scores are stored in `playing11`

## Data Sources

The app prefers database data first:

- players are loaded from `cricketers`
- teams are loaded from `teams`

If those queries fail, the backend falls back to bundled in-memory datasets from:

- `backend/src/data/players.js`
- `backend/src/data/teams.js`

This keeps the app partly usable even if the DB is temporarily unavailable.

## Scripts

### Backend

- `npm run dev` - run backend with nodemon
- `npm start` - run backend normally
- `npm run db:test` - database connectivity test

### Frontend

- `npm run dev` - start Vite dev server
- `npm run build` - production build
- `npm run preview` - preview production build
- `npm run lint` - run ESLint

## Operational Notes

### Voice Chat

- voice chat requires microphone permission
- browser secure context rules apply
- localhost usually works in development

### History and Openable Rooms

- completed rooms appear in history
- only currently live sessions should expose an open-room action
- finished sessions remain archived

### Stuck Auction Recovery

The server contains timer and transition watchdog logic to recover rooms if:

- a timer disappears unexpectedly
- a room gets stuck in `sold`
- a room gets stuck in `transitioning`

The frontend also attempts a room resync if live auction events stop arriving for several seconds.

## Troubleshooting

### Login works but room creation fails

Check:

- `JWT_SECRET` is set in `backend/.env`
- the frontend is sending the token to the backend
- the backend has been restarted after env changes

### Supabase schema errors

Make sure the schema from `backend/db/schema.sql` has been applied, especially:

- `users.password_hash`
- `rooms.session_number`
- `UNIQUE (room_code, session_number)`

### Public room not visible

Public rooms are shown only while:

- the room is marked `public`
- the room is still in `waiting` status
- at least one lobby participant is present

### Voice chat does not work

Check:

- browser mic permissions
- secure context rules
- network restrictions on WebRTC

## Verification

Useful checks during development:

```bash
cd backend
node --check src/index.js
```

```bash
cd frontend
npm run build
```

```bash
cd frontend
npx eslint src/pages/Auction.jsx
```

## Known Notes

- the frontend still has a small ESLint hook warning around `slugMap` in `Auction.jsx` / `Result.jsx`
- room recovery is strong for normal reconnects, but like any in-memory live room system, a full server restart during an active auction can still interrupt the live runtime state

## Author

Created by **Duveen Kumar Reddy R**
