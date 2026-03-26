export const rooms = new Map();
export const PUBLIC_ROOMS_CHANNEL = "public_rooms_watchers";

const OPENABLE_ROOM_STATUSES = new Set([
  "waiting",
  "starting",
  "transitioning",
  "running",
  "picking",
  "finished_finalized",
]);

export function isRuntimeRoomOpenable(roomCode, roomDbId) {
  const room = rooms.get(String(roomCode || "").trim());
  if (!room) return false;

  const sameSession =
    Number(room.dbId || 0) > 0 &&
    Number(roomDbId || 0) > 0 &&
    Number(room.dbId) === Number(roomDbId);

  return sameSession && OPENABLE_ROOM_STATUSES.has(room.status);
}
