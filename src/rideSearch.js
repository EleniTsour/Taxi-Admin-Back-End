import { pool } from "./db.js";
import { resolveIdColumn } from "./dbColumns.js";

export const MAX_PAGED_SEARCH_ROWS = 200;
export const MAX_EXPORT_PDF_ROWS = 3000;
export const MAX_EXPORT_EXCEL_ROWS = 10000;

let cachedTheDateDataType = null;

export const EXPORT_COLUMNS = [
  { key: "A/A", label: "A/A" },
  { key: "THE_DATE", label: "Date" },
  { key: "TIME", label: "Time" },
  { key: "TYPE", label: "Type" },
  { key: "FROM", label: "From" },
  { key: "TO", label: "To" },
  { key: "HOTEL NAME", label: "Hotel Name" },
  { key: "AREA", label: "Area" },
  { key: "FLY_CODE", label: "Fly Code" },
  { key: "FLY_COMPANY", label: "Fly Company" },
  { key: "THE_NAME", label: "Customer Name" },
  { key: "EMAIL", label: "Email" },
  { key: "PAX", label: "Pax" },
  { key: "ADULT", label: "Adult" },
  { key: "CH/INF", label: "Ch/Inf" },
  { key: "INFO", label: "Info" },
  { key: "VCode", label: "V Code" },
  { key: "TOUR_OPER", label: "Tour Operator" },
  { key: "PRICE", label: "Price" },
  { key: "DRIVER", label: "Driver" },
  { key: "DRIVER_PRICE", label: "Driver Price" },
];

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

function buildNormalizedDateExpr() {
  return [
    "COALESCE(",
    "DATE(`THE_DATE`),",
    "STR_TO_DATE(SUBSTRING_INDEX(`THE_DATE`, 'T', 1), '%Y-%m-%d'),",
    "STR_TO_DATE(`THE_DATE`, '%d/%m/%Y'),",
    "STR_TO_DATE(`THE_DATE`, '%Y-%m-%d')",
    ")",
  ].join(" ");
}

function buildRideSelectSql(idColumn, isNativeDateType, normalizedDateExpr) {
  return `
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
  `;
}

export async function buildRideSearchContext(query) {
  const {
    from,
    to,
    from_location,
    to_location,
    tour_oper,
    driver,
    sortBy,
    sortDir,
  } = query;

  const idColumn = await resolveIdColumn("data");
  const theDateType = await resolveTheDateDataType();
  const isNativeDateType = ["date", "datetime", "timestamp"].includes(theDateType);
  const normalizedDateExpr = buildNormalizedDateExpr();
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
      where.push("`THE_DATE` < DATE_ADD(?, INTERVAL 1 DAY)");
      params.push(to);
    } else {
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

  return {
    idColumn,
    isNativeDateType,
    normalizedDateExpr,
    params,
    requestedSortBy,
    normalizedSortDir,
    orderBySql,
    whereSql,
  };
}

export async function fetchRideSearchPage(query, page, pageSize) {
  const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
  const currentPageSize = Math.min(MAX_PAGED_SEARCH_ROWS, Math.max(10, Number.parseInt(pageSize, 10) || 50));
  const offset = (currentPage - 1) * currentPageSize;
  const context = await buildRideSearchContext(query);
  const total = await countMatchingRides(query, context);

  const sql = `
    ${buildRideSelectSql(context.idColumn, context.isNativeDateType, context.normalizedDateExpr)}
    ${context.whereSql}
    ORDER BY ${context.orderBySql}
    LIMIT ? OFFSET ?
  `;
  const [rows] = await pool.query(sql, [...context.params, currentPageSize, offset]);

  return {
    rows,
    total,
    page: currentPage,
    pageSize: currentPageSize,
    sortBy: context.requestedSortBy,
    sortDir: context.normalizedSortDir.toLowerCase(),
  };
}

export async function countMatchingRides(query, existingContext = null) {
  const context = existingContext ?? await buildRideSearchContext(query);
  const countSql = `
    SELECT COUNT(*) AS total
    FROM data
    ${context.whereSql}
  `;
  const [countRows] = await pool.query(countSql, context.params);
  return Number(countRows?.[0]?.total ?? 0);
}

export async function fetchAllMatchingRides(query, limit) {
  const context = await buildRideSearchContext(query);
  const total = await countMatchingRides(query, context);

  if (total > limit) {
    const err = new Error(`Export is limited to ${limit} rides. Please narrow the filters and try again.`);
    err.status = 413;
    err.total = total;
    err.limit = limit;
    throw err;
  }

  const sql = `
    ${buildRideSelectSql(context.idColumn, context.isNativeDateType, context.normalizedDateExpr)}
    ${context.whereSql}
    ORDER BY ${context.orderBySql}
    LIMIT ?
  `;
  const [rows] = await pool.query(sql, [...context.params, limit]);

  return {
    rows,
    total,
    limit,
    sortBy: context.requestedSortBy,
    sortDir: context.normalizedSortDir.toLowerCase(),
  };
}
