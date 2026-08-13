import { getRuntimeRoomOpenInfo } from "../runtimeRooms.js";

const RESUMABLE_ROOM_STATUSES = new Set([
  "waiting",
  "starting",
  "transitioning",
  "running",
  "sold",
  "picking",
  "finished_finalized",
]);

function getFallbackRoomStatus(roomStatus) {
  return roomStatus === "ongoing" ? "running" : String(roomStatus || "waiting").trim();
}

export function buildStoredRoomOpenInfo(room, storedState) {
  const runtimeInfo = getRuntimeRoomOpenInfo(room.roomCode, room.id);
  if (runtimeInfo.canOpen) {
    return runtimeInfo;
  }

  const status = String(storedState?.status || getFallbackRoomStatus(room.status)).trim();
  if (!RESUMABLE_ROOM_STATUSES.has(status)) {
    return { canOpen: false, status: "closed", openTarget: null };
  }

  const deadlineMs = Number(storedState?.selectDeadline || 0);
  const resultTimerExpired =
    deadlineMs > 0 &&
    Date.now() >= deadlineMs &&
    (status === "picking" || status === "finished_finalized");

  if (resultTimerExpired) {
    return { canOpen: false, status: "closed", openTarget: null };
  }

  if (room.status === "finished" && !["picking", "finished_finalized"].includes(status)) {
    return { canOpen: false, status: "closed", openTarget: null };
  }

  return {
    canOpen: true,
    status,
    openTarget: status === "waiting" ? "lobby" : "auction",
  };
}
