export const rooms = new Map();
export const PUBLIC_ROOMS_CHANNEL = "public_rooms_watchers";

const OPENABLE_ROOM_STATUSES = new Set([
  "waiting",
  "starting",
  "transitioning",
  "running",
  "sold",
  "picking",
  "finished_finalized",
]);

export function getRuntimeRoomForSession(roomCode, roomDbId) {
  const room = rooms.get(String(roomCode || "").trim());
  if (!room) return null;

  const sameSession =
    Number(room.dbId || 0) > 0 &&
    Number(roomDbId || 0) > 0 &&
    Number(room.dbId) === Number(roomDbId);

  if (!sameSession) {
    return null;
  }

  return room;
}

export function getRuntimeRoomOpenInfo(roomCode, roomDbId) {
  const room = getRuntimeRoomForSession(roomCode, roomDbId);
  if (!room || !OPENABLE_ROOM_STATUSES.has(room.status)) {
    return { canOpen: false, status: "closed", openTarget: null };
  }

  const deadlineMs = Number(room.selectDeadline || 0);
  const resultTimerExpired = deadlineMs > 0 && Date.now() >= deadlineMs;
  if (resultTimerExpired && (room.status === "picking" || room.status === "finished_finalized")) {
    return { canOpen: false, status: "closed", openTarget: null };
  }

  return {
    canOpen: true,
    status: room.status,
    openTarget: room.status === "waiting" ? "lobby" : "auction",
  };
}

export function isRuntimeRoomOpenable(roomCode, roomDbId) {
  return getRuntimeRoomOpenInfo(roomCode, roomDbId).canOpen;
}
