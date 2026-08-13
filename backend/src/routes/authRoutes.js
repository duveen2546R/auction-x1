import express from "express";
import pool, { formatDbError } from "../db.js";
import {
  generatePasswordResetToken,
  hashPassword,
  hashPasswordResetToken,
  signAuthToken,
  verifyPassword,
} from "../auth.js";
import {
  getPasswordResetBaseUrl,
  sendPasswordResetEmail,
  sendWelcomeEmail,
} from "../mailer.js";
import requireAuth from "../middleware/requireAuth.js";
import {
  normalizeEmailInput,
  normalizePasswordInput,
  normalizeUsernameInput,
} from "../utils/input.js";

const router = express.Router();

async function findUserByUsername(username) {
  const [rows] = await pool.query(
    `SELECT id, username, email, password_hash AS "passwordHash"
     FROM users
     WHERE LOWER(username) = LOWER(?)
     LIMIT 1`,
    [username]
  );
  return rows[0] || null;
}

async function findUserByEmail(email) {
  const [rows] = await pool.query(
    `SELECT id, username, email, password_hash AS "passwordHash"
     FROM users
     WHERE LOWER(email) = LOWER(?)
     LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

function buildAuthResponse(user) {
  return {
    token: signAuthToken(user),
    user: {
      id: Number(user.id),
      username: user.username,
      email: user.email || null,
    },
  };
}

router.post("/register", async (req, res) => {
  const username = normalizeUsernameInput(req.body?.username);
  const password = normalizePasswordInput(req.body?.password);
  const email = normalizeEmailInput(req.body?.email);

  if (!username) {
    return res.status(400).json({ error: "Username must be between 3 and 50 characters" });
  }
  if (!email) {
    return res.status(400).json({ error: "A valid email address is required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  try {
    const existingUser = await findUserByUsername(username);
    const existingEmailUser = await findUserByEmail(email);
    const passwordHash = await hashPassword(password);

    if (existingUser?.passwordHash) {
      return res.status(409).json({ error: "Username is already registered" });
    }
    if (existingEmailUser && Number(existingEmailUser.id) !== Number(existingUser?.id || 0)) {
      return res.status(409).json({ error: "Email is already registered" });
    }

    let user;
    if (existingUser) {
      await pool.query(
        "UPDATE users SET username = ?, email = ?, password_hash = ? WHERE id = ?",
        [username, email, passwordHash, existingUser.id]
      );
      user = { id: existingUser.id, username, email };
    } else {
      const [insertResult] = await pool.query(
        "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?) RETURNING id, username, email",
        [username, email, passwordHash]
      );
      user = insertResult.rows?.[0] || { id: insertResult.insertId, username, email };
    }

    sendWelcomeEmail({ email, username }).catch((mailError) => {
      console.error("Failed to send welcome email", formatDbError(mailError));
    });

    return res.status(201).json(buildAuthResponse(user));
  } catch (err) {
    console.error("Failed to register user", formatDbError(err));
    return res.status(500).json({ error: "Failed to register user" });
  }
});

router.post("/login", async (req, res) => {
  const username = normalizeUsernameInput(req.body?.username);
  const password = normalizePasswordInput(req.body?.password);

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  try {
    const user = await findUserByUsername(username);
    if (!user?.passwordHash) {
      return res.status(401).json({ error: "This username is not registered yet" });
    }

    const matches = await verifyPassword(password, user.passwordHash);
    if (!matches) {
      return res.status(401).json({ error: "Incorrect username or password" });
    }

    return res.json(buildAuthResponse(user));
  } catch (err) {
    console.error("Failed to log in user", formatDbError(err));
    return res.status(500).json({ error: "Failed to log in" });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, username, email FROM users WHERE id = ? LIMIT 1",
      [req.auth.userId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({
      user: {
        id: Number(rows[0].id),
        username: rows[0].username,
        email: rows[0].email || null,
      },
    });
  } catch (err) {
    console.error("Failed to fetch session user", formatDbError(err));
    return res.status(500).json({ error: "Failed to fetch session" });
  }
});

router.post("/forgot-password", async (req, res) => {
  const email = normalizeEmailInput(req.body?.email);
  if (!email) {
    return res.status(400).json({ error: "A valid email address is required" });
  }

  const genericResponse = {
    ok: true,
    message: "If that email is registered, a password reset link has been sent.",
  };

  try {
    const user = await findUserByEmail(email);
    if (!user) return res.json(genericResponse);

    const rawToken = generatePasswordResetToken();
    const tokenHash = hashPasswordResetToken(rawToken);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await pool.query("DELETE FROM password_reset_tokens WHERE user_id = ?", [user.id]);
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES (?, ?, ?)`,
      [user.id, tokenHash, expiresAt.toISOString()]
    );

    const resetUrl = `${getPasswordResetBaseUrl()}/reset-password?token=${encodeURIComponent(rawToken)}`;
    const delivery = await sendPasswordResetEmail(email, resetUrl);

    return res.json({
      ...genericResponse,
      debugResetUrl: delivery.loggedOnly ? resetUrl : undefined,
    });
  } catch (err) {
    console.error("Failed to generate password reset", formatDbError(err));
    return res.status(500).json({ error: "Failed to process password reset request" });
  }
});

router.post("/reset-password", async (req, res) => {
  const token = String(req.body?.token || "").trim();
  const password = normalizePasswordInput(req.body?.password);

  if (!token) {
    return res.status(400).json({ error: "Reset token is required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  try {
    const tokenHash = hashPasswordResetToken(token);
    const [rows] = await pool.query(
      `SELECT id, user_id AS "userId", expires_at AS "expiresAt", used_at AS "usedAt"
       FROM password_reset_tokens
       WHERE token_hash = ?
       LIMIT 1`,
      [tokenHash]
    );

    if (!rows.length) {
      return res.status(400).json({ error: "Reset link is invalid or expired" });
    }

    const resetRow = rows[0];
    const expired = resetRow.expiresAt ? new Date(resetRow.expiresAt).getTime() < Date.now() : true;
    if (resetRow.usedAt || expired) {
      return res.status(400).json({ error: "Reset link is invalid or expired" });
    }

    const passwordHash = await hashPassword(password);
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, resetRow.userId]);
    await pool.query("UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?", [resetRow.id]);
    await pool.query("DELETE FROM password_reset_tokens WHERE user_id = ?", [resetRow.userId]);

    return res.json({ ok: true, message: "Password reset successful" });
  } catch (err) {
    console.error("Failed to reset password", formatDbError(err));
    return res.status(500).json({ error: "Failed to reset password" });
  }
});

export default router;
