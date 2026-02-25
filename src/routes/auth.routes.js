import { Router } from "express";
import { pool } from "../db.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { requireAuth } from "../auth.js";

const router = Router();

function getCookieOptions() {
  const secureDefault = process.env.NODE_ENV === "production";
  const secure = String(process.env.COOKIE_SECURE ?? secureDefault).toLowerCase() === "true";
  const sameSite = process.env.COOKIE_SAMESITE ?? (secure ? "none" : "lax");
  return {
    httpOnly: true,
    sameSite,
    secure,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

// Login: sets httpOnly cookie token
router.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: "Missing email/password" });

  const [rows] = await pool.query("SELECT id, email, password_hash, role FROM users WHERE email = ?", [email]);
  const user = rows?.[0];
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  const cookieOptions = getCookieOptions();
  res.cookie("token", token, cookieOptions);

  res.json({ ok: true, email: user.email, role: user.role });
});

router.post("/logout", (req, res) => {
  const cookieOptions = getCookieOptions();
  res.clearCookie("token", {
    httpOnly: cookieOptions.httpOnly,
    sameSite: cookieOptions.sameSite,
    secure: cookieOptions.secure,
  });
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({
    ok: true,
    user: {
      userId: req.user?.userId,
      email: req.user?.email,
      role: req.user?.role,
    },
  });
});

router.post("/change-password", requireAuth, async (req, res) => {
  const userId = req.user?.userId;
  const { currentPassword, newPassword } = req.body ?? {};

  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Missing current/new password" });
  }

  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }

  const [rows] = await pool.query(
    "SELECT id, password_hash FROM users WHERE id = ? LIMIT 1",
    [userId],
  );
  const user = rows?.[0];
  if (!user) return res.status(404).json({ error: "User not found" });

  const isCurrentValid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!isCurrentValid) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  const isSameAsCurrent = await bcrypt.compare(newPassword, user.password_hash);
  if (isSameAsCurrent) {
    return res.status(400).json({ error: "New password must be different from current password." });
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  await pool.query("UPDATE users SET password_hash = ? WHERE id = ? LIMIT 1", [newHash, userId]);

  res.json({ ok: true });
});

export default router;
