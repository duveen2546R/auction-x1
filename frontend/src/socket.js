import { io } from "socket.io-client";

const socket = io(
  import.meta.env.VITE_API_URL || "http://localhost:5000",
  {
    path: "/auction/socket.io",
    transports: ["websocket", "polling"],
    secure: true,
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    withCredentials: true,
  }
);

export default socket;