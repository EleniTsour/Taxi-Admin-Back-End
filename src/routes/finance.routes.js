import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import {
  fetchFinancePage,
  fetchFinanceById,
  normalizeFinanceEntry,
  normalizeTourOperator,
} from "../finance.js";
import { buildFinancePdfBuffer } from "../financePdf.js";
import { toCsv } from "../csv.js";

const router = Router();
const requireFinanceAccess = [requireAuth];

function sendFinanceError(res, err, fallback) {
  const status = Number(err?.status || 500);
  if (status >= 400 && status < 500) return res.status(status).json({ error: err.message });
  console.error(fallback, err);
  return res.status(status >= 500 && status <= 599 ? status : 500).json({ error: "Internal server error" });
}

router.post("/", ...requireFinanceAccess, async (req, res) => {
  try {
    const entry = normalizeFinanceEntry(req.body ?? {});
    const tourOperator = await normalizeTourOperator(req.body?.tourOperator);
    const [result] = await pool.query(
      "INSERT INTO finance (`TOUR_OPER`, `THE_DATE`, `CHARGE`, `PAYMENT`, `NOTES`) VALUES (?, ?, ?, ?, ?)",
      [tourOperator, entry.date, entry.charge, entry.payment, entry.notes],
    );
    return res.status(201).json({ ok: true, id: result.insertId });
  } catch (err) {
    return sendFinanceError(res, err, "Could not create Finance entry.");
  }
});

router.get("/search", ...requireFinanceAccess, async (req, res) => {
  try {
    return res.json(await fetchFinancePage(req.query));
  } catch (err) {
    return sendFinanceError(res, err, "Could not search Finance entries.");
  }
});

// Full CSV backup of the persisted finance table. Balance is intentionally
// absent because it is calculated at query time and is not table data.
router.get("/backup.csv", ...requireFinanceAccess, async (_req, res) => {
  const [columnRows] = await pool.query("SHOW COLUMNS FROM finance");
  const columns = columnRows.map((row) => String(row.Field ?? "")).filter(Boolean);
  const [rows] = await pool.query("SELECT * FROM finance");
  const csv = toCsv(rows, columns);
  const datePart = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="finance_backup_${datePart}.csv"`);
  res.status(200).send(`\uFEFF${csv}`);
});

// Mirrors the direct authenticated voucher action used by Ride Search. The
// authoritative row is fetched server-side and rendered by the same function
// used for full Finance reports.
router.get("/:id/pdf", ...requireFinanceAccess, async (req, res) => {
  try {
    const row = await fetchFinanceById(req.params.id);
    if (!row) return res.status(404).json({ error: "Finance entry not found." });
    const pdf = await buildFinancePdfBuffer({ rows: [row], tourOperator: row.tourOperator, includeTotals: false });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="finance_report_${row.id}.pdf"`);
    return res.status(200).send(pdf);
  } catch (err) {
    return sendFinanceError(res, err, "Could not generate Finance PDF.");
  }
});

router.delete("/:id", ...requireFinanceAccess, async (req, res) => {
  const id = String(req.params.id ?? "").trim();
  if (!id) return res.status(400).json({ error: "Missing Finance id." });
  const [result] = await pool.query("DELETE FROM finance WHERE `AA` = ? LIMIT 1", [id]);
  if (!result?.affectedRows) return res.status(404).json({ error: "Finance entry not found." });
  return res.json({ ok: true, id });
});

export default router;
