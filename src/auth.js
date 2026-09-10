import jwt from "jsonwebtoken";
import { randomBytes, timingSafeEqual } from "node:crypto";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function tokensMatch(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""));
  const rightBuffer = Buffer.from(String(right ?? ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createCsrfToken() {
  return randomBytes(32).toString("base64url");
}

export function requireAuth(req, res, next) {
  const authHeader = String(req.headers?.authorization ?? "");
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const cookieToken = req.cookies?.token;
  const token = bearerToken || cookieToken;
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    req.authType = bearerToken ? "bearer" : "cookie";

    if (req.authType === "cookie" && !SAFE_METHODS.has(req.method)) {
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
