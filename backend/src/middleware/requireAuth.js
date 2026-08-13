import { verifyAuthToken } from "../auth.js";

export default function requireAuth(req, res, next) {
  const authHeader = String(req.headers.authorization || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    req.auth = verifyAuthToken(token);
    return next();
  } catch (_error) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}
