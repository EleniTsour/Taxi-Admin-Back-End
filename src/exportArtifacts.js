import PDFDocument from "pdfkit";
import { EXPORT_COLUMNS } from "./rideSearch.js";
import * as XLSX from "./vendor/xlsx.mjs";

function formatDateForVoucherDisplay(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;

  const european = raw.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (european) return `${european[1]}/${european[2]}/${european[3]}`;

  return raw;
}

function toVoucherData(ride = {}) {
  return {
    AA: ride["A/A"] ?? ride.AA ?? "",
    THE_DATE: formatDateForVoucherDisplay(ride.THE_DATE ?? ride.DATE ?? ""),
    TIME: ride.TIME ?? "",
    TYPE: ride.TYPE ?? "",
    FROM: ride.FROM ?? "",
    TO: ride.TO ?? "",
    HOTEL: ride["HOTEL NAME"] ?? ride.HOTEL ?? "",
    AREA: ride.AREA ?? "",
    FLY_CODE: ride.FLY_CODE ?? "",
    FLY_COMPANY: ride.FLY_COMPANY ?? "",
    THE_NAME: ride.THE_NAME ?? ride["CUSTOMER NAME"] ?? "",
    PAX: ride.PAX ?? "",
    ADULT: ride.ADULT ?? "",
    CH_INF: ride["CH/INF"] ?? ride.CH_INF ?? "",
    INFO: ride.INFO ?? "",
    COMPANY_NAME: ride.COMPANY_NAME ?? "Versa tours",
    COMPANY_LINE1: ride.COMPANY_LINE1 ?? "Transfer and Tours in Crete",
    COMPANY_WEB: ride.COMPANY_WEB ?? "http://www.versatours.gr",
    COMPANY_GNTO: ride.COMPANY_GNTO ?? "GNTO 1039E81000282101",
    COMPANY_VAT: ride.COMPANY_VAT ?? "VAT 039273005",
    COMPANY_TEL: ride.COMPANY_TEL ?? "Tel +306972250074",
    COMPANY_EMAIL: ride.COMPANY_EMAIL ?? "Email mailbox@versatours.gr",
  };
}

export function buildExcelWorkbook(rows) {
  const headerRow = EXPORT_COLUMNS.map((column) => column.label);
  const dataRows = rows.map((row) => (
    EXPORT_COLUMNS.map((column) => String(row[column.key] ?? ""))
  ));
  const priceColumnIndex = EXPORT_COLUMNS.findIndex((column) => column.key === "PRICE");
  const totalPrice = rows.reduce((sum, row) => sum + Number(row.PRICE ?? 0), 0);
  const totalRowCells = new Array(EXPORT_COLUMNS.length).fill("");
  if (priceColumnIndex > 0) totalRowCells[priceColumnIndex - 1] = "Total Price";
  if (priceColumnIndex >= 0) totalRowCells[priceColumnIndex] = totalPrice.toFixed(2);
  const sheet = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows, [], totalRowCells]);
  sheet["!cols"] = EXPORT_COLUMNS.map((column) => ({
    wch: Math.max(12, column.label.length + 2),
  }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Rides");
  return workbook;
}

export function buildExcelBuffer(rows) {
  const workbook = buildExcelWorkbook(rows);
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

export function buildPdfBuffer(buildFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 36, left: 28, right: 28, bottom: 36 },
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    buildFn(doc);
    doc.end();
  });
}

export async function buildCombinedVoucherPdfBuffer(rows, renderVoucherPage) {
  const vouchers = rows.map((ride) => toVoucherData(ride));
  return buildPdfBuffer((doc) => {
    vouchers.forEach((voucher, index) => {
      if (index > 0) doc.addPage();
      renderVoucherPage(doc, voucher);
    });
  });
}

export { toVoucherData };
