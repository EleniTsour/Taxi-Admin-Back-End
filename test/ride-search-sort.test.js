import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../src/db.js";
import { buildRideSearchContext } from "../src/rideSearch.js";

test("Tour Operator sorting is case-insensitive and keeps blanks last", async () => {
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    if (sql.includes("COLUMN_NAME IN")) return [[{ COLUMN_NAME: "A/A" }]];
    if (sql.includes("LOWER(DATA_TYPE)")) return [[{ dataType: "date" }]];
    throw new Error(`Unexpected query: ${sql}`);
  };

  try {
    const ascending = await buildRideSearchContext({ sortBy: "TOUR_OPER", sortDir: "asc" });
    const descending = await buildRideSearchContext({ sortBy: "TOUR_OPER", sortDir: "desc" });

    assert.equal(ascending.normalizedSortDir, "ASC");
    assert.match(ascending.orderBySql, /^CASE WHEN TRIM\(COALESCE\(`TOUR_OPER`, ''\)\) = '' THEN 1 ELSE 0 END ASC, LOWER\(`TOUR_OPER`\) ASC/);
    assert.equal(descending.normalizedSortDir, "DESC");
    assert.match(descending.orderBySql, /LOWER\(`TOUR_OPER`\) DESC/);
  } finally {
    pool.query = originalQuery;
  }
});
