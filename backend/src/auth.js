import crypto from "crypto";

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
let warnedAboutFallbackSecret = false;

function getAuthSecret() {
  if (process.env.JWT_SECRET?.trim()) {
    return process.env.JWT_SECRET.trim();
  }

  if (!warnedAboutFallbackSecret) {
    warnedAboutFallbackSecret = true;
    console.warn("JWT_SECRET is not set. Using a development fallback secret; configure JWT_SECRET in backend/.env for production.");
  }

  return "auctionxi-dev-secret-change-me";
}

function encodeBase64Url(value) {
  const input = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.from(input).toString("base64url");
}

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signSegment(unsignedToken) {
  return crypto.createHmac("sha256", getAuthSecret()).update(unsignedToken).digest("base64url");
}

export function signAuthToken(user) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    sub: Number(user.id),
    username: user.username,
    iat: issuedAt,
    exp: issuedAt + TOKEN_TTL_SECONDS,
  };

  const unsignedToken = `${encodeBase64Url({ alg: "HS256", typ: "JWT" })}.${encodeBase64Url(payload)}`;
  const signature = signSegment(unsignedToken);
  return `${unsignedToken}.${signature}`;
}

export function verifyAuthToken(token) {
  const value = String(token || "").trim();
  const parts = value.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed token");
  }

  const [headerPart, payloadPart, signaturePart] = parts;
  const expectedSignature = signSegment(`${headerPart}.${payloadPart}`);
  const actualBuffer = Buffer.from(signaturePart);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid token signature");
  }

  const payload = JSON.parse(decodeBase64Url(payloadPart));
  if (!payload?.sub || !payload?.username) {
    throw new Error("Invalid token payload");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && Number(payload.exp) < now) {
    throw new Error("Token expired");
  }

  return {
    userId: Number(payload.sub),
    username: String(payload.username),
    exp: Number(payload.exp || 0),
  };
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });

  return `scrypt$${salt}$${Buffer.from(derivedKey).toString("hex")}`;
}

export async function verifyPassword(password, storedHash) {
  const [algorithm, salt, hashedValue] = String(storedHash || "").split("$");
  if (algorithm !== "scrypt" || !salt || !hashedValue) {
    return false;
  }

  const derivedKey = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });

  const actualBuffer = Buffer.from(hashedValue, "hex");
  const expectedBuffer = Buffer.from(derivedKey);

  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export async function ensureAuthSchema(pool) {
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT");
}
