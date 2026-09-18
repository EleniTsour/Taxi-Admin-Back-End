import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateFinanceTotals, renderFinancePdf } from "../src/financePdf.js";

class RecordingPdfDocument {
  constructor({ height = 500 } = {}) {
    this.page = { width: 400, height, margins: { left: 30, right: 30, top: 30, bottom: 30 } };
    this.y = 0;
    this.pageCount = 1;
    this.color = "";
    this.texts = [];
  }

  fillColor(color) { this.color = color; return this; }
  font() { return this; }
  fontSize() { return this; }
  strokeColor() { return this; }
  lineWidth() { return this; }
  moveTo() { return this; }
  lineTo() { return this; }
  stroke() { return this; }
  heightOfString(value) { return Math.max(12, Math.ceil(String(value).length / 55) * 14); }
  addPage() { this.pageCount += 1; this.y = this.page.margins.top; return this; }

  text(value, x, y) {
    const positionY = typeof y === "number" ? y : (typeof x === "number" ? this.y : this.y);
    this.texts.push({ value: String(value), color: this.color, y: positionY });
    this.y = positionY + this.heightOfString(value);
    return this;
  }
}

function textValues(doc) {
  return doc.texts.map((entry) => entry.value).join("\n");
}

test("Finance PDF renders compact inline record fields, accented operator, and decimal-safe totals", () => {
  const doc = new RecordingPdfDocument();
  renderFinancePdf(doc, {
    tourOperator: "ALACARTE",
    from: "2026-09-01",
    to: "2026-09-30",
    rows: [
      { date: "2026-09-01", charge: "100.50", payment: "20.25", balance: "80.25", notes: "Greek σημείωση" },
      { date: "2026-09-02", charge: "1100.00", payment: "1200.75", balance: "-100.75", notes: "Second note" },
    ],
  });

  const output = textValues(doc);
  assert.match(output, /Date:/);
  assert.match(output, / 01\/09\/2026/);
  assert.match(output, /Charge: €100\.50    Payment: €20\.25    Balance: €80\.25/);
  assert.equal(doc.texts.find((entry) => entry.value === " ALACARTE")?.color, "#1F6F8B");
  assert.match(output, /Period:/);
  assert.match(output, /01\/09\/2026 - 30\/09\/2026/);
  assert.match(output, /Totals/);
  assert.match(output, /Total Charge:/);
  assert.match(output, / €1,200\.50/);
  assert.match(output, /Total Payment:/);
  assert.match(output, / €1,221\.00/);
  assert.match(output, /Total Balance:/);
  assert.match(output, / -€20\.50/);
});

test("Finance PDF omits period without date filters and omits totals for an individual record", () => {
  const doc = new RecordingPdfDocument();
  renderFinancePdf(doc, {
    tourOperator: "Alpha Tours",
    includeTotals: false,
    rows: [{ date: "2026-09-01", charge: "100.00", payment: "60.00", balance: "40.00", notes: "One row" }],
  });

  const output = textValues(doc);
  assert.doesNotMatch(output, /Period:|From:|Until:/);
  assert.doesNotMatch(output, /Totals|Total Charge|Total Payment|Total Balance/);
});

test("Finance totals use integer cents for decimal and negative balances", () => {
  const totals = calculateFinanceTotals([
    { charge: "100.50", payment: "20.25" },
    { charge: "0.10", payment: "120.45" },
  ]);

  assert.equal(totals.charge, 10060n);
  assert.equal(totals.payment, 14070n);
  assert.equal(totals.charge - totals.payment, -4010n);
});

test("Finance totals move together to a new page when the final page lacks room", () => {
  const doc = new RecordingPdfDocument({ height: 170 });
  renderFinancePdf(doc, {
    tourOperator: "Alpha Tours",
    rows: [{ date: "2026-09-01", charge: "100.00", payment: "0.00", balance: "100.00", notes: "Short note" }],
  });

  assert.ok(doc.pageCount >= 2);
  assert.match(textValues(doc), /Totals/);
});
