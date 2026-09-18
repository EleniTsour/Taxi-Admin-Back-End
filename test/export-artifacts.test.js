import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExcelBuffer, buildFinanceExcelBuffer } from "../src/exportArtifacts.js";
import * as XLSX from "../src/vendor/xlsx.mjs";

test("ride and Finance Excel generators produce XLSX archives", () => {
  const rides = buildExcelBuffer([{ "A/A": 1, THE_DATE: "2026-09-15", PRICE: "100.50", THE_NAME: "Maria" }]);
  const finance = buildFinanceExcelBuffer([{
    tourOperator: "Ελληνικά Tours", date: "2026-09-15", charge: "100.50", payment: "20.25", balance: "80.25", notes: "Greek σημείωση",
  }]);

  assert.equal(rides.subarray(0, 2).toString(), "PK");
  assert.equal(finance.subarray(0, 2).toString(), "PK");
});

test("Finance Excel orders Notes immediately after Date", () => {
  const buffer = buildFinanceExcelBuffer([{
    tourOperator: "Alpha Tours", date: "2026-09-15", notes: "Invoice 7",
    charge: "100.50", payment: "20.25", balance: "80.25",
  }]);
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheet = workbook.Sheets.Finance;

  assert.deepEqual(["A1", "B1", "C1", "D1", "E1", "F1"].map((cell) => sheet[cell].v), [
    "Tour Operator", "Date", "Notes", "Charge", "Payment", "Balance",
  ]);
  assert.equal(sheet.C2.v, "Invoice 7");
  assert.equal(sheet.D2.v, 100.5);
  assert.equal(sheet.F2.v, 80.25);
});
