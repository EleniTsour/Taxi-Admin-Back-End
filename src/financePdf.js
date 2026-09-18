import { buildPdfBuffer } from "./exportArtifacts.js";
import { FONT_BOLD, FONT_REGULAR } from "./pdfVoucher.js";
import { readFile } from "node:fs/promises";

const BODY_COLOR = "#16202A";
const MUTED_COLOR = "#52616F";
const ACCENT_COLOR = "#1F6F8B";
const RULE_COLOR = "#D8E0E7";
const FINANCE_LOGO_URL = new URL("../../frontend/public/versa-logo.png", import.meta.url);
let financeLogoPromise = null;

// Reuse the existing local application logo and cache it for export jobs.
async function loadFinanceLogoBuffer() {
  if (!financeLogoPromise) {
    financeLogoPromise = readFile(FINANCE_LOGO_URL).catch((error) => {
      financeLogoPromise = null;
      throw error;
    });
  }
  return financeLogoPromise;
}

function displayDate(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : String(value ?? "");
}

function amountToCents(value) {
  const raw = String(value ?? "0").trim();
  const match = raw.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return 0n;
  const cents = BigInt(`${match[2]}${(match[3] ?? "").padEnd(2, "0")}`);
  return match[1] === "-" ? -cents : cents;
}

function euroFromCents(cents) {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}\u20AC${whole}.${fraction}`;
}

function euro(value) {
  return euroFromCents(amountToCents(value));
}

// Finance values come from DECIMAL columns. Summing integer cents avoids
// JavaScript floating-point rounding and preserves the database precision.
export function calculateFinanceTotals(rows = []) {
  return rows.reduce((totals, row) => ({
    charge: totals.charge + amountToCents(row?.charge),
    payment: totals.payment + amountToCents(row?.payment),
  }), { charge: 0n, payment: 0n });
}

function periodDetails({ from, to }) {
  if (from && to) return { label: "Period:", value: `${displayDate(from)} - ${displayDate(to)}` };
  if (from) return { label: "From:", value: displayDate(from) };
  if (to) return { label: "Until:", value: displayDate(to) };
  return null;
}

function drawHeader(doc, { tourOperator, from, to, continuation = false, logoBuffer = null }) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  let y = doc.page.margins.top;

  const logoWidth = 112;
  const logoHeight = 42;
  if (!continuation && logoBuffer) {
    const logoX = doc.page.width - doc.page.margins.right - logoWidth;
    doc.image(logoBuffer, logoX, y, { fit: [logoWidth, logoHeight], align: "right", valign: "top" });
  }
  doc.fillColor(BODY_COLOR).font(FONT_BOLD).fontSize(continuation ? 12 : 20)
    .text(continuation ? "Finance Report (continued)" : "Finance Report", left, y, { width: continuation ? width : width - logoWidth - 16 });
  y += continuation ? 22 : 32;

  if (!continuation) {
    const operator = String(tourOperator ?? "");
    doc.fillColor(MUTED_COLOR).font(FONT_BOLD).fontSize(10).text("Tour Operator:", left, y, { continued: true });
    doc.fillColor(ACCENT_COLOR).font(FONT_BOLD).text(` ${operator}`, { width: Math.max(0, width - 95) });
    y += 20;

    const period = periodDetails({ from, to });
    if (period) {
      doc.fillColor(MUTED_COLOR).font(FONT_BOLD).fontSize(9).text(period.label, left, y, { continued: true });
      doc.fillColor(BODY_COLOR).font(FONT_REGULAR).text(` ${period.value}`);
      y += 19;
    }
  }

  doc.strokeColor("#BFC9D4").lineWidth(0.75).moveTo(left, y).lineTo(left + width, y).stroke();
  return y + 16;
}

function drawInlineField(doc, { label, value, left, y, valueColor = BODY_COLOR }) {
  doc.fillColor(MUTED_COLOR).font(FONT_BOLD).fontSize(9).text(`${label}:`, left, y, { continued: true });
  doc.fillColor(valueColor).font(FONT_REGULAR).fontSize(10).text(` ${value}`);
}

function drawRecord(doc, row, y, logoBuffer) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const notes = String(row.notes ?? "").trim() || "-";
  const notesHeight = doc.font(FONT_REGULAR).fontSize(10).heightOfString(notes, { width, lineGap: 4 });
  const recordHeight = 17 + 17 + 12 + 13 + notesHeight + 24;

  if (y + recordHeight > bottom && y > doc.page.margins.top) {
    doc.addPage();
    y = drawHeader(doc, { continuation: true, logoBuffer });
  }

  drawInlineField(doc, { label: "Date", value: displayDate(row.date), left, y });
  y += 18;

  const amounts = `Charge: ${euro(row.charge)}    Payment: ${euro(row.payment)}    Balance: ${euro(row.balance)}`;
  doc.fillColor(BODY_COLOR).font(FONT_BOLD).fontSize(10).text(amounts, left, y, { width });
  y += 22;

  doc.fillColor(MUTED_COLOR).font(FONT_BOLD).fontSize(9).text("NOTES", left, y);
  y += 13;
  doc.fillColor("#26323D").font(FONT_REGULAR).fontSize(10).text(notes, left, y, {
    width,
    lineGap: 4,
    lineBreak: true,
  });
  y = doc.y + 14;
  doc.strokeColor(RULE_COLOR).lineWidth(0.75).moveTo(left, y).lineTo(left + width, y).stroke();
  return y + 16;
}

function drawTotals(doc, totals, y, logoBuffer) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const balance = totals.charge - totals.payment;
  const totalHeight = 84;

  if (y + totalHeight > bottom) {
    doc.addPage();
    y = drawHeader(doc, { continuation: true, logoBuffer });
  }

  doc.strokeColor("#91A4B5").lineWidth(1).moveTo(left, y).lineTo(left + width, y).stroke();
  y += 13;
  doc.fillColor(BODY_COLOR).font(FONT_BOLD).fontSize(12).text("Totals", left, y);
  y += 21;
  drawInlineField(doc, { label: "Total Charge", value: euroFromCents(totals.charge), left, y });
  y += 16;
  drawInlineField(doc, { label: "Total Payment", value: euroFromCents(totals.payment), left, y });
  y += 16;
  drawInlineField(doc, { label: "Total Balance", value: euroFromCents(balance), left, y, valueColor: ACCENT_COLOR });
  return y + 18;
}

// Used for full filtered reports and the authenticated single-record PDF.
// The individual-record endpoint deliberately disables aggregate totals.
export function renderFinancePdf(doc, { rows = [], tourOperator, from, to, includeTotals = true, logoBuffer = null }) {
  let y = drawHeader(doc, { tourOperator, from, to, logoBuffer });
  for (const row of rows) y = drawRecord(doc, row, y, logoBuffer);
  if (includeTotals) drawTotals(doc, calculateFinanceTotals(rows), y, logoBuffer);
}

export async function buildFinancePdfBuffer(options) {
  const logoBuffer = await loadFinanceLogoBuffer();
  return buildPdfBuffer((doc) => renderFinancePdf(doc, { ...options, logoBuffer }));
}
