import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { resolveIdColumn } from "../dbColumns.js";

const router = Router();

// Get all prices (for dropdowns)
router.get("/", requireAuth, async (req, res) => {
  const idColumn = await resolveIdColumn("prices");
  const [rows] = await pool.query(
    `SELECT \`${idColumn}\` AS id, \`Destination\` AS destination, \`Tour\` AS tour, \`Price\` AS price FROM prices ORDER BY \`Destination\`, \`Tour\``
  );
  res.json(rows);
});

// Lookup single price by destination + tour_oper
router.get("/lookup", requireAuth, async (req, res) => {
  const { destination, tour } = req.query;
  if (!destination || !tour) return res.status(400).json({ error: "Missing destination/tour" });

  const [rows] = await pool.query(
    "SELECT `Price` AS price FROM prices WHERE `Destination` = ? AND `Tour` = ? LIMIT 1",
    [destination, tour]
  );

  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

export default router;
