import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeExportQuery } from "../src/exportJobs.js";

test("queued ride exports preserve the active Customer Name filter", () => {
  const query = normalizeExportQuery({
    tour_oper: "Alpha Tours",
    customer_name: "Maria",
    sortBy: "THE_DATE",
    sortDir: "asc",
  }, "excel");

  assert.deepEqual(query, {
    tour_oper: "Alpha Tours",
    customer_name: "Maria",
    sortBy: "THE_DATE",
    sortDir: "asc",
  });
});
