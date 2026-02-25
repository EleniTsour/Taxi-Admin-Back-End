import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import cookieParser from "cookie-parser";

import authRoutes from "./routes/auth.routes.js";
import pricesRoutes from "./routes/prices.routes.js";
import ridesRoutes from "./routes/rides.routes.js";
import pdfRoutes from "./routes/pdf.routes.js";

dotenv.config();

const app = express();

function normalizeOrigin(origin) {
  return String(origin ?? "").trim().replace(/\/+$/, "");
}

const configuredOrigins = String(process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map(normalizeOrigin)
  .filter(Boolean);

const fallbackOrigins = ["http://localhost:5173", "https://versa-reg.eu", "https://www.versa-reg.eu"];
const allowedOrigins = configuredOrigins.length ? configuredOrigins : fallbackOrigins;

const corsOptions = {
  credentials: true,
  origin(origin, callback) {
    // Allow non-browser clients (no Origin header).
    if (!origin) return callback(null, true);

    const requestOrigin = normalizeOrigin(origin);
    if (allowedOrigins.includes(requestOrigin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
};

app.use(cors(corsOptions));

app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRoutes);
app.use("/prices", pricesRoutes);
app.use("/rides", ridesRoutes);
app.use("/pdf", pdfRoutes);

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, next) => {
  console.error(err);

  if (String(err?.message || "").startsWith("CORS blocked for origin:")) {
    return res.status(403).json({ error: err.message });
  }

  const isDbError =
    err?.code === "ECONNREFUSED" ||
    err?.code === "ETIMEDOUT" ||
    err?.code === "EHOSTUNREACH" ||
    err?.code === "ER_ACCESS_DENIED_ERROR" ||
    err?.code === "ER_BAD_DB_ERROR" ||
    err?.code === "ENOTFOUND" ||
    err?.code === "PROTOCOL_CONNECTION_LOST" ||
    err?.code === "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR";

  if (isDbError) {
    return res.status(503).json({
      error: "Database unavailable",
      detail: "Backend is running, but database is not connected/configured.",
      code: err?.code || "UNKNOWN_DB_ERROR",
    });
  }

  return res.status(500).json({ error: "Internal server error" });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, "0.0.0.0", () => console.log(`API running on port ${port}`));
