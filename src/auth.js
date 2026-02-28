import jwt from "jsonwebtoken";

export function requireAuth(req, res, next) {
  const authHeader = String(req.headers?.authorization ?? "");
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const cookieToken = req.cookies?.token;
  const token = bearerToken || cookieToken;
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}
