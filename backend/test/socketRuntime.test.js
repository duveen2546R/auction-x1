import assert from "node:assert/strict";
import test from "node:test";
import { createAuctionRuntime } from "../src/socket/auctionRuntime.js";

test("auction runtime registers the Socket.IO connection boundary", () => {
  const listeners = new Map();
  const io = {
    on(event, handler) {
      listeners.set(event, handler);
    },
    sockets: { adapter: { rooms: new Map() } },
  };

  const runtime = createAuctionRuntime(io);
  runtime.dispose();

  assert.equal(typeof runtime.initialize, "function");
  assert.equal(typeof listeners.get("connection"), "function");
});
