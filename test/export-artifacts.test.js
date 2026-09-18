import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExcelBuffer, buildFinanceExcelBuffer } from "../src/exportArtifacts.js";

test("ride and Finance Excel generators produce XLSX archives", () => {
  const rides = buildExcelBuffer([{ "A/A": 1, THE_DATE: "2026-09-15", PRICE: "100.50", THE_NAME: "Maria" }]);
  const finance = buildFinanceExcelBuffer([{
    tourOperator: "Ελληνικά Tours", date: "2026-09-15", charge: "100.50", payment: "20.25", balance: "80.25", notes: "Greek σημείωση",
  }]);

  assert.equal(rides.subarray(0, 2).toString(), "PK");
  assert.equal(finance.subarray(0, 2).toString(), "PK");
});
