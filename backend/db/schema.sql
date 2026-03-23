CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rooms (
  id SERIAL PRIMARY KEY,
  room_code VARCHAR(10) UNIQUE,
  host_id INT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'waiting' CHECK (status IN ('waiting', 'ongoing', 'finished')),
  max_players INT DEFAULT 10,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE,
  budget DECIMAL(10,2) DEFAULT 120.00
);

CREATE TABLE IF NOT EXISTS room_players (
  id SERIAL PRIMARY KEY,
  room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  budget DECIMAL(10,2) DEFAULT 120.00,
  team_name VARCHAR(50),
  team_id INT REFERENCES teams(id) ON DELETE SET NULL,
  UNIQUE (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS cricketers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100),
  role VARCHAR(50),
  base_price DECIMAL(10,2),
  rating DECIMAL(10,2),
  batting_rating DECIMAL(10,2),
  bowling_rating DECIMAL(10,2),
  country VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS bids (
  id SERIAL PRIMARY KEY,
  room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
  player_id INT REFERENCES cricketers(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  bid_amount DECIMAL(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS team_players (
  id SERIAL PRIMARY KEY,
  room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  player_id INT REFERENCES cricketers(id) ON DELETE CASCADE,
  price DECIMAL(10,2)
);

CREATE TABLE IF NOT EXISTS unsold_players (
  id SERIAL PRIMARY KEY,
  room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
  player_id INT REFERENCES cricketers(id) ON DELETE CASCADE,
  UNIQUE(room_id, player_id)
);

CREATE TABLE IF NOT EXISTS auction_state (
  id SERIAL PRIMARY KEY,
  room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
  state JSONB
);

CREATE TABLE IF NOT EXISTS playing11 (
  id SERIAL PRIMARY KEY,
  room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  lineup JSONB,
  score DECIMAL(10,2)
);
