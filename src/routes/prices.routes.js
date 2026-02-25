import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { resolveIdColumn } from "../dbColumns.js";

const router = Router();

function csvCell(value) {
  const safe = String(value ?? "")
    .replace(/"/g, '""')
    .replace(/\r?\n/g, " ");
  return `"${safe}"`;
}

function toCsv(rows, columnNames) {
  const header = columnNames.map((c) => csvCell(c)).join(",");
  const lines = rows.map((row) => (
    columnNames.map((c) => csvCell(row[c])).join(",")
  ));
  return [header, ...lines].join("\r\n");
}

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

// Full CSV backup of prices table
router.get("/backup.csv", requireAuth, async (_req, res) => {
  const [columnRows] = await pool.query("SHOW COLUMNS FROM prices");
  const columns = columnRows.map((r) => String(r.Field ?? "")).filter(Boolean);

  const [rows] = await pool.query("SELECT * FROM prices");
  const csv = toCsv(rows, columns);
  const datePart = new Date().toISOString().slice(0, 10);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=\"prices_backup_${datePart}.csv\"`);
  res.status(200).send(`\uFEFF${csv}`);
});

export default router;
