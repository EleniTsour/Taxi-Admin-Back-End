import assert from "node:assert/strict";
import { test } from "node:test";
import { csvCell, toCsv } from "../src/csv.js";

test("CSV serialization neutralizes formula-leading values without changing normal text", () => {
  assert.equal(csvCell("=SUM(A1:A2)"), "\"'=SUM(A1:A2)\"");
  assert.equal(csvCell("+1+1"), "\"'+1+1\"");
  assert.equal(csvCell("-1+1"), "\"'-1+1\"");
  assert.equal(csvCell("@something"), "\"'@something\"");
  assert.equal(csvCell("-1"), "\"-1\"");
  assert.equal(csvCell("normal text"), "\"normal text\"");
  assert.equal(csvCell("Ελληνικά, \"quoted\"\ntext"), "\"Ελληνικά, \"\"quoted\"\" text\"");
});

test("CSV serialization preserves the existing header and row structure", () => {
  assert.equal(
    toCsv([{ Notes: "normal", Amount: 0 }], ["Notes", "Amount"]),
    "\"Notes\",\"Amount\"\r\n\"normal\",\"0\"",
  );
});
