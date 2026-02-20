import { pool } from "./db.js";

const ID_COLUMN_CANDIDATES = ["A/A", "Αναγνωριστικό"];
const cache = new Map();

export async function resolveIdColumn(tableName) {
  if (cache.has(tableName)) return cache.get(tableName);

  const [rows] = await pool.query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME IN (?, ?)
      ORDER BY FIELD(COLUMN_NAME, ?, ?)
      LIMIT 1
    `,
    [tableName, ID_COLUMN_CANDIDATES[0], ID_COLUMN_CANDIDATES[1], ID_COLUMN_CANDIDATES[0], ID_COLUMN_CANDIDATES[1]],
  );

  const column = rows?.[0]?.COLUMN_NAME || ID_COLUMN_CANDIDATES[0];
  cache.set(tableName, column);
  return column;
}
