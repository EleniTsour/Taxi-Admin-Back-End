import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { resolveIdColumn } from "../dbColumns.js";

const router = Router();

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
];

/**
 * Insert new ride
 * Body fields must match your frontend keys:
 * THE_DATE, TIME, TYPE, FROM, TO, HOTEL NAME, AREA, FLY_CODE, FLY_COMPANY,
 * THE_NAME, EMAIL, PAX, ADULT, CH/INF, INFO, VCode, TOUR_OPER, PRICE
 */
router.post("/", requireAuth, async (req, res) => {
  const b = req.body ?? {};

  // Minimal required fields
  const required = ["THE_DATE", "TIME", "TYPE", "FROM", "TO", "THE_NAME"];
  const missing = required.filter((k) => !String(b[k] ?? "").trim());
  if (missing.length) return res.status(400).json({ error: "Missing required fields", missing });

  const sql = `
    INSERT INTO data
    (\`THE_DATE\`, \`TIME\`, \`TYPE\`, \`FROM\`, \`TO\`,
     \`HOTEL NAME\`, \`AREA\`, \`FLY_CODE\`, \`FLY_COMPANY\`,
     \`THE_NAME\`, \`EMAIL\`, \`PAX\`, \`ADULT\`, \`CH/INF\`,
     \`INFO\`, \`VCode\`, \`TOUR_OPER\`, \`PRICE\`, \`DRIVER\`)
    VALUES
    (?, ?, ?, ?, ?,
     ?, ?, ?, ?,
     ?, ?, ?, ?, ?,
     ?, ?, ?, ?, ?)
  `;

  const params = [
    b.THE_DATE,
    b.TIME,
    b.TYPE,
    b.FROM,
    b.TO,
    toNullableString(b["HOTEL NAME"]),
    toNullableString(b.AREA),
    toNullableString(b.FLY_CODE),
    toNullableString(b.FLY_COMPANY),
    b.THE_NAME,
    toNullableString(b.EMAIL),
    toNullableNumber(b.PAX),
    toNullableNumber(b.ADULT),
    toNullableString(b["CH/INF"]),
    toNullableString(b.INFO),
    toNullableString(b.VCode),
    toNullableString(b.TOUR_OPER),
    toNullableNumber(b.PRICE),
    toNullableString(b.DRIVER),
  ];

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

  for (const field of UPSERT_FIELDS) {
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
 * Search rides (your required filters):
 * GET /rides/search?from=YYYY-MM-DD&to=YYYY-MM-DD&from_location=...&to_location=...&tour_oper=...&page=1&pageSize=50&sortBy=THE_DATE&sortDir=desc
 */
router.get("/search", requireAuth, async (req, res) => {
  const {
    from,
    to,
    from_location,
    to_location,
    tour_oper,
    page,
    pageSize,
    sortBy,
    sortDir,
  } = req.query;
  const idColumn = await resolveIdColumn("data");
  const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
  const currentPageSize = Math.min(200, Math.max(10, Number.parseInt(pageSize, 10) || 50));
  const offset = (currentPage - 1) * currentPageSize;

  const where = [];
  const params = [];

  if (from) {
    where.push("`THE_DATE` >= ?");
    params.push(from);
  }
  if (to) {
    where.push("`THE_DATE` <= ?");
    params.push(to);
  }
  if (tour_oper) {
    where.push("`TOUR_OPER` = ?");
    params.push(tour_oper);
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
    THE_DATE: "`THE_DATE`",
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
      \`${idColumn}\` AS \`A/A\`, \`THE_DATE\`, \`TIME\`, \`TYPE\`, \`FROM\`, \`TO\`,
      \`HOTEL NAME\`, \`AREA\`, \`FLY_CODE\`, \`FLY_COMPANY\`,
      \`THE_NAME\`, \`EMAIL\`, \`PAX\`, \`ADULT\`, \`CH/INF\`,
      \`INFO\`, \`VCode\`, \`TOUR_OPER\`, \`PRICE\`, \`DRIVER\`
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
 * PDF export (stub for now)
 */
router.get("/report.pdf", requireAuth, async (req, res) => {
  res.status(501).send("PDF export not implemented yet.");
});

export default router;
