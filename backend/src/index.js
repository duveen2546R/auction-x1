import http from "http";
import { Server } from "socket.io";
import "./env.js";
import { createApp } from "./app.js";
import { ensureAuthSchema } from "./auth.js";
import { getSocketCorsOptions } from "./config/socket.js";
import pool, {
  formatDbError,
  getDatabaseSummary,
  verifyDatabaseConnection,
} from "./db.js";
import { ensureRoomSessionSchema } from "./roomSessions.js";
import { createAuctionRuntime } from "./socket/auctionRuntime.js";

const app = createApp();
const server = http.createServer(app);
const io = new Server(server, { cors: getSocketCorsOptions() });
const auctionRuntime = createAuctionRuntime(io);

async function bootstrap() {
  const db = getDatabaseSummary();
  try {
    await verifyDatabaseConnection();
    await ensureAuthSchema(pool);
    await ensureRoomSessionSchema(pool);
    console.log(`Supabase Postgres connected at ${db.host}:${db.port}/${db.database}`);
  } catch (err) {
    console.warn(
      `Supabase Postgres unavailable at ${db.host}:${db.port}/${db.database}; starting with fallback data where supported: ${formatDbError(err)}`
    );
  }

  await auctionRuntime.initialize();

  const port = process.env.PORT || 5000;
  server.listen(port, () => {
    console.log(`Auction server listening on ${port}`);
  });
}

bootstrap();
