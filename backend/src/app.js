import cors from "cors";
import express from "express";
import apiRouter from "./routes/index.js";

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(apiRouter);
  return app;
}
