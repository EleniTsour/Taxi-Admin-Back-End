import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { resolveIdColumn } from "../dbColumns.js";
import {
  MAX_EXPORT_EXCEL_ROWS,
  fetchAllMatchingRides,
  fetchRideSearchPage,
} from "../rideSearch.js";
import { buildExcelBuffer } from "../exportArtifacts.js";

const router = Router();
let cachedDataColumns = null;

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

async function resolveDataColumns() {
  if (cachedDataColumns) return cachedDataColumns;

  const [rows] = await pool.query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = COALESCE(?, DATABASE())
        AND TABLE_NAME = 'data'
    `,
    [process.env.DB_NAME || null],
  );

  cachedDataColumns = new Set(rows.map((r) => String(r.COLUMN_NAME ?? "")));
  return cachedDataColumns;
}

function toNullableNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNullableString(value) {
  const raw = String(value ?? "").trim();
  return raw ? raw : null;
}

const UPSERT_FIELDS = [
  { key: "THE_DATE", cast: toNullableString },
  { key: "TIME", cast: toNullableString },
  { key: "TYPE", cast: toNullableString },
  { key: "FROM", cast: toNullableString },
  { key: "TO", cast: toNullableString },
  { key: "HOTEL NAME", cast: toNullableString },
  { key: "AREA", cast: toNullableString },
  { key: "FLY_CODE", cast: toNullableString },
  { key: "FLY_COMPANY", cast: toNullableString },
  { key: "THE_NAME", cast: toNullableString },
  { key: "EMAIL", cast: toNullableString },
  { key: "PAX", cast: toNullableNumber },
  { key: "ADULT", cast: toNullableNumber },
  { key: "CH/INF", cast: toNullableString },
  { key: "INFO", cast: toNullableString },
  { key: "VCode", cast: toNullableString },
  { key: "TOUR_OPER", cast: toNullableString },
  { key: "PRICE", cast: toNullableNumber },
  { key: "DRIVER", cast: toNullableString },
  { key: "DRIVER_PRICE", cast: toNullableNumber },
];

/**
 * Insert new ride
 * Body fields must match your frontend keys:
 * THE_DATE, TIME, TYPE, FROM, TO, HOTEL NAME, AREA, FLY_CODE, FLY_COMPANY,
 * THE_NAME, EMAIL, PAX, ADULT, CH/INF, INFO, VCode, TOUR_OPER, PRICE, DRIVER, DRIVER_PRICE
 */
router.post("/", requireAuth, async (req, res) => {
  const b = req.body ?? {};

  // Minimal required fields
  const required = ["THE_DATE", "FROM", "TO"];
  const missing = required.filter((k) => !String(b[k] ?? "").trim());
  if (missing.length) return res.status(400).json({ error: "Missing required fields", missing });

  const availableColumns = await resolveDataColumns();
  const insertCandidates = [
    { key: "THE_DATE", value: b.THE_DATE },
    { key: "TIME", value: b.TIME },
    { key: "TYPE", value: b.TYPE },
    { key: "FROM", value: b.FROM },
    { key: "TO", value: b.TO },
    { key: "HOTEL NAME", value: toNullableString(b["HOTEL NAME"]) },
    { key: "AREA", value: toNullableString(b.AREA) },
    { key: "FLY_CODE", value: toNullableString(b.FLY_CODE) },
    { key: "FLY_COMPANY", value: toNullableString(b.FLY_COMPANY) },
    { key: "THE_NAME", value: b.THE_NAME },
    { key: "EMAIL", value: toNullableString(b.EMAIL) },
    { key: "PAX", value: toNullableNumber(b.PAX) },
    { key: "ADULT", value: toNullableNumber(b.ADULT) },
    { key: "CH/INF", value: toNullableString(b["CH/INF"]) },
    { key: "INFO", value: toNullableString(b.INFO) },
    { key: "VCode", value: toNullableString(b.VCode) },
    { key: "TOUR_OPER", value: toNullableString(b.TOUR_OPER) },
    { key: "PRICE", value: toNullableNumber(b.PRICE) },
    { key: "DRIVER", value: toNullableString(b.DRIVER) },
    { key: "DRIVER_PRICE", value: toNullableNumber(b.DRIVER_PRICE) },
  ];
  const insertFields = insertCandidates.filter((f) => availableColumns.has(f.key));
  if (insertFields.length === 0) {
    return res.status(500).json({ error: "Data table schema is invalid (no known columns)." });
  }

  const columnsSql = insertFields.map((f) => `\`${f.key}\``).join(", ");
  const placeholdersSql = insertFields.map(() => "?").join(", ");
  const sql = `INSERT INTO data (${columnsSql}) VALUES (${placeholdersSql})`;
  const params = insertFields.map((f) => f.value);

  const [result] = await pool.query(sql, params);
  res.json({ ok: true, id: result.insertId });
});

/**
 * Update ride by id column (A/A or Αναγνωριστικό), excluding id itself.
 * PUT /rides/:id
 */
router.put("/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id ?? "").trim();
  if (!id) return res.status(400).json({ error: "Missing ride id" });

  const body = req.body ?? {};
  const setParts = [];
  const values = [];
  const availableColumns = await resolveDataColumns();

  for (const field of UPSERT_FIELDS) {
    if (!availableColumns.has(field.key)) continue;
    if (!Object.prototype.hasOwnProperty.call(body, field.key)) continue;
    setParts.push(`\`${field.key}\` = ?`);
    values.push(field.cast(body[field.key]));
  }

  if (setParts.length === 0) {
    return res.status(400).json({ error: "No updatable fields provided." });
  }

  const idColumn = await resolveIdColumn("data");
  const sql = `
    UPDATE data
    SET ${setParts.join(", ")}
    WHERE \`${idColumn}\` = ?
    LIMIT 1
  `;

  const [result] = await pool.query(sql, [...values, id]);
  if (!result?.affectedRows) {
    return res.status(404).json({ error: "Ride not found." });
  }

  return res.json({ ok: true, id });
});

/**
 * Delete ride by id
 * DELETE /rides/:id
 */
router.delete("/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id ?? "").trim();
  if (!id) return res.status(400).json({ error: "Missing ride id" });

  const idColumn = await resolveIdColumn("data");
  const sql = `
    DELETE FROM data
    WHERE \`${idColumn}\` = ?
    LIMIT 1
  `;

  const [result] = await pool.query(sql, [id]);
  if (!result?.affectedRows) {
    return res.status(404).json({ error: "Ride not found." });
  }

  return res.json({ ok: true, id });
});

/**
 * Search rides (your required filters):
 * GET /rides/search?from=YYYY-MM-DD&to=YYYY-MM-DD&from_location=...&to_location=...&tour_oper=...&driver=...&page=1&pageSize=50&sortBy=THE_DATE&sortDir=desc
 */
router.get("/search", requireAuth, async (req, res) => {
  const { page, pageSize } = req.query;
  const result = await fetchRideSearchPage(req.query, page, pageSize);
  res.json(result);
});

/**
 * Excel-compatible export for the current filtered result set.
 * GET /rides/search/export.xlsx?...
 * Legacy/manual route: Search / Reports now uses the queued /exports flow instead.
 * TODO: remove this route after the queued /exports flow is verified in production.
 */
router.get("/search/export.xlsx", requireAuth, async (req, res) => {
  console.warn("Legacy export route used: GET /rides/search/export.xlsx");
  try {
    const result = await fetchAllMatchingRides(req.query, MAX_EXPORT_EXCEL_ROWS);
    const workbookBuffer = buildExcelBuffer(result.rows);
    const datePart = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=\"rides_report_${datePart}.xlsx\"`);
    return res.status(200).send(workbookBuffer);
  } catch (err) {
    const status = Number(err?.status || 500);
    return res.status(status).json({
      error: err?.message || "Could not export Excel.",
      total: err?.total ?? undefined,
      limit: err?.limit ?? MAX_EXPORT_EXCEL_ROWS,
    });
  }
});

/**
 * Full CSV backup of data table
 */
router.get("/backup.csv", requireAuth, async (_req, res) => {
  const [columnRows] = await pool.query("SHOW COLUMNS FROM data");
  const columns = columnRows.map((r) => String(r.Field ?? "")).filter(Boolean);

  const [rows] = await pool.query("SELECT * FROM data");
  const csv = toCsv(rows, columns);
  const datePart = new Date().toISOString().slice(0, 10);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=\"data_backup_${datePart}.csv\"`);
  res.status(200).send(`\uFEFF${csv}`);
});

/**
 * Distinct options for ride filters/forms.
 */
router.get("/options", requireAuth, async (_req, res) => {
  const [driverRows] = await pool.query(
    "SELECT DISTINCT `DRIVER` AS driver FROM data WHERE `DRIVER` IS NOT NULL AND TRIM(`DRIVER`) <> '' ORDER BY `DRIVER`",
  );
  const drivers = driverRows.map((r) => String(r.driver ?? "").trim()).filter(Boolean);
  res.json({ drivers });
});

/**
 * PDF export (stub for now)
 */
router.get("/report.pdf", requireAuth, async (req, res) => {
  res.status(501).send("PDF export not implemented yet.");
});

export default router;
