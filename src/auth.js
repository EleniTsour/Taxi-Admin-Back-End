import jwt from "jsonwebtoken";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pool } from "./db.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function tokensMatch(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""));
  const rightBuffer = Buffer.from(String(right ?? ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createCsrfToken() {
  return randomBytes(32).toString("base64url");
}

export async function requireAuth(req, res, next) {
  const cookieToken = req.cookies?.token;
  if (!cookieToken) return res.status(401).json({ error: "Not authenticated" });

  try {
    const payload = jwt.verify(cookieToken, process.env.JWT_SECRET);
    if (!payload.csrfToken) {
      return res.status(401).json({ error: "Session renewal required" });
    }
    const tokenSessionVersion = Number(payload.sessionVersion ?? 0);
    if (!Number.isSafeInteger(tokenSessionVersion) || tokenSessionVersion < 0) {
      return res.status(401).json({ error: "Invalid token" });
    }
    const [users] = await pool.query(
      "SELECT `session_version` AS sessionVersion FROM users WHERE id = ? LIMIT 1",
      [payload.userId],
    );
    const user = users?.[0];
    if (!user || Number(user.sessionVersion ?? 0) !== tokenSessionVersion) {
      return res.status(401).json({ error: "Session expired. Please log in again." });
    }
    req.user = payload;

    if (!SAFE_METHODS.has(req.method)) {
      const cookieToken = req.cookies?.csrf_token;
      const headerToken = req.get("X-CSRF-Token");
      if (!payload.csrfToken || !tokensMatch(cookieToken, payload.csrfToken) || !tokensMatch(headerToken, payload.csrfToken)) {
        return res.status(403).json({ error: "Invalid or missing CSRF token" });
      }
    }

    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}
