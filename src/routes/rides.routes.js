import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { resolveIdColumn } from "../dbColumns.js";

const router = Router();
let cachedTheDateDataType = null;
let cachedDataColumns = null;

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

async function resolveTheDateDataType() {
  if (cachedTheDateDataType) return cachedTheDateDataType;
  const [rows] = await pool.query(
    `
      SELECT LOWER(DATA_TYPE) AS dataType
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = COALESCE(?, DATABASE())
        AND TABLE_NAME = 'data'
        AND COLUMN_NAME = 'THE_DATE'
      LIMIT 1
    `,
    [process.env.DB_NAME || null],
  );
  cachedTheDateDataType = String(rows?.[0]?.dataType ?? "");
  return cachedTheDateDataType;
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
  const {
    from,
    to,
    from_location,
    to_location,
    tour_oper,
    driver,
    page,
    pageSize,
    sortBy,
    sortDir,
  } = req.query;
  const idColumn = await resolveIdColumn("data");
  const theDateType = await resolveTheDateDataType();
  const isNativeDateType = ["date", "datetime", "timestamp"].includes(theDateType);
  const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
  const currentPageSize = Math.min(200, Math.max(10, Number.parseInt(pageSize, 10) || 50));
  const offset = (currentPage - 1) * currentPageSize;
  const normalizedDateExpr = [
    "COALESCE(",
    "DATE(`THE_DATE`),",
    "STR_TO_DATE(SUBSTRING_INDEX(`THE_DATE`, 'T', 1), '%Y-%m-%d'),",
    "STR_TO_DATE(`THE_DATE`, '%d/%m/%Y'),",
    "STR_TO_DATE(`THE_DATE`, '%Y-%m-%d')",
    ")",
  ].join(" ");

  const where = [];
  const params = [];

  if (from) {
    if (isNativeDateType) {
      where.push("`THE_DATE` >= ?");
      params.push(from);
    } else {
      where.push(`${normalizedDateExpr} >= ?`);
      params.push(from);
    }
  }
  if (to) {
    if (isNativeDateType) {
      // Inclusive end-date for native datetime/date columns.
      where.push("`THE_DATE` < DATE_ADD(?, INTERVAL 1 DAY)");
      params.push(to);
    } else {
      // Inclusive end-date based on normalized calendar date.
      where.push(`${normalizedDateExpr} <= ?`);
      params.push(to);
    }
  }
  if (tour_oper) {
    where.push("`TOUR_OPER` = ?");
    params.push(tour_oper);
  }
  if (driver) {
    where.push("`DRIVER` = ?");
    params.push(driver);
  }
  if (from_location) {
    where.push("`FROM` = ?");
    params.push(from_location);
  }
  if (to_location) {
    where.push("`TO` = ?");
    params.push(to_location);
  }

  const sortableColumns = {
    "A/A": `\`${idColumn}\``,
    THE_DATE: isNativeDateType ? "`THE_DATE`" : normalizedDateExpr,
    TIME: "`TIME`",
  };
  const requestedSortBy = String(sortBy ?? "THE_DATE");
  const sortExpr = sortableColumns[requestedSortBy] ?? "`THE_DATE`";
  const normalizedSortDir = String(sortDir ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const orderBySql = requestedSortBy === "THE_DATE"
    ? `${sortExpr} ${normalizedSortDir}, \`TIME\` DESC`
    : `${sortExpr} ${normalizedSortDir}, \`THE_DATE\` DESC, \`TIME\` DESC`;

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const countSql = `
    SELECT COUNT(*) AS total
    FROM data
    ${whereSql}
  `;

  const [countRows] = await pool.query(countSql, params);
  const total = Number(countRows?.[0]?.total ?? 0);

  const sql = `
    SELECT
      \`${idColumn}\` AS \`A/A\`,
      ${isNativeDateType
    ? "DATE_FORMAT(`THE_DATE`, '%Y-%m-%d')"
    : `DATE_FORMAT(${normalizedDateExpr}, '%Y-%m-%d')`} AS \`THE_DATE\`,
      \`TIME\`, \`TYPE\`, \`FROM\`, \`TO\`,
      \`HOTEL NAME\`, \`AREA\`, \`FLY_CODE\`, \`FLY_COMPANY\`,
      \`THE_NAME\`, \`EMAIL\`, \`PAX\`, \`ADULT\`, \`CH/INF\`,
      \`INFO\`, \`VCode\`, \`TOUR_OPER\`, \`PRICE\`, \`DRIVER\`, \`DRIVER_PRICE\`
    FROM data
    ${whereSql}
    ORDER BY ${orderBySql}
    LIMIT ? OFFSET ?
  `;

  const [rows] = await pool.query(sql, [...params, currentPageSize, offset]);
  res.json({
    rows,
    total,
    page: currentPage,
    pageSize: currentPageSize,
    sortBy: requestedSortBy,
    sortDir: normalizedSortDir.toLowerCase(),
  });
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
