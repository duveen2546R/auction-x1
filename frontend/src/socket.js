import { io } from "socket.io-client";

const URL = import.meta.env.VITE_API_URL || "http://localhost:5000";

console.log("SOCKET DEBUG URL =", URL);

const socket = io(URL, {
  path: "/socket.io",
  transports: ["websocket", "polling"],
  secure: true,
  withCredentials: true,
});

export default socket;