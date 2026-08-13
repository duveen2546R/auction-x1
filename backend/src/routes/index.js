import express from "express";
import authRoutes from "./authRoutes.js";
import catalogRoutes from "./catalogRoutes.js";
import historyRoutes from "./historyRoutes.js";
import roomRoutes from "./roomRoutes.js";

const router = express.Router();

router.use(catalogRoutes);
router.use("/auth", authRoutes);
router.use("/rooms", roomRoutes);
router.use("/user/history", historyRoutes);

export default router;
