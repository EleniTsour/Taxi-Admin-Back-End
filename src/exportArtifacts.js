import PDFDocument from "pdfkit";
import { EXPORT_COLUMNS } from "./rideSearch.js";

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

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

export function buildSpreadsheetXml(rows) {
  const buildSpreadsheetRow = (cells, styleId = "Default") => (
    `<Row>${cells.map((value) => `<Cell ss:StyleID="${styleId}"><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`).join("")}</Row>`
  );

  const headerRow = buildSpreadsheetRow(EXPORT_COLUMNS.map((column) => column.label), "Header");
  const dataRows = rows.map((row) => buildSpreadsheetRow(
    EXPORT_COLUMNS.map((column) => String(row[column.key] ?? "")),
  )).join("");
  const priceColumnIndex = EXPORT_COLUMNS.findIndex((column) => column.key === "PRICE");
  const totalPrice = rows.reduce((sum, row) => sum + Number(row.PRICE ?? 0), 0);
  const totalRowCells = new Array(EXPORT_COLUMNS.length).fill("");
  if (priceColumnIndex > 0) totalRowCells[priceColumnIndex - 1] = "Total Price";
  if (priceColumnIndex >= 0) totalRowCells[priceColumnIndex] = totalPrice.toFixed(2);
  const totalRow = buildSpreadsheetRow(totalRowCells, "Header");

  return [
    "<?xml version=\"1.0\"?>",
    "<?mso-application progid=\"Excel.Sheet\"?>",
    "<Workbook xmlns=\"urn:schemas-microsoft-com:office:spreadsheet\"",
    " xmlns:o=\"urn:schemas-microsoft-com:office:office\"",
    " xmlns:x=\"urn:schemas-microsoft-com:office:excel\"",
    " xmlns:ss=\"urn:schemas-microsoft-com:office:spreadsheet\">",
    "<Styles>",
    "<Style ss:ID=\"Default\" ss:Name=\"Normal\"><Alignment ss:Vertical=\"Top\" ss:WrapText=\"1\"/></Style>",
    "<Style ss:ID=\"Header\"><Font ss:Bold=\"1\"/><Alignment ss:Vertical=\"Top\" ss:WrapText=\"1\"/></Style>",
    "</Styles>",
    "<Worksheet ss:Name=\"Rides\">",
    "<Table>",
    headerRow,
    dataRows,
    "<Row></Row>",
    totalRow,
    "</Table>",
    "</Worksheet>",
    "</Workbook>",
  ].join("");
}

export function buildExcelBuffer(rows) {
  return Buffer.from(buildSpreadsheetXml(rows), "utf8");
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
