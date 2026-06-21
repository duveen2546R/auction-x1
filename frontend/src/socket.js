import { io } from "socket.io-client";

const socket = io("https://savorgo.centralindia.cloudapp.azure.com", {
  path: "/auction/socket.io",
  transports: ["websocket", "polling"],
  secure: true,
  withCredentials: true,
});

export default socket;