import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function pickFirstExisting(paths = []) {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

const FONT_REGULAR =
  pickFirstExisting([
    path.resolve(MODULE_DIR, "../assets/fonts/NotoSans-Regular.ttf"),
    path.resolve(MODULE_DIR, "../assets/fonts/DejaVuSans.ttf"),
    "C:\\Windows\\Fonts\\arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
  ]) || "Helvetica";

const FONT_BOLD =
  pickFirstExisting([
    path.resolve(MODULE_DIR, "../assets/fonts/NotoSans-Bold.ttf"),
    path.resolve(MODULE_DIR, "../assets/fonts/DejaVuSans-Bold.ttf"),
    "C:\\Windows\\Fonts\\arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
  ]) || "Helvetica-Bold";

export function renderVoucherPage(doc, data) {
  const leftX = 28;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colGap = 24;
  const colWidth = (contentWidth - colGap) / 2;
  const rightX = leftX + colWidth + colGap;
  const labelWidth = 90;

  const drawField = (label, value, x, y, width) => {
    const safe = String(value ?? "");
    const valueWidth = Math.max(40, width - labelWidth - 6);

    doc.font(FONT_BOLD).fontSize(10).text(`${label}:`, x, y, { width: labelWidth });

    doc.font(FONT_REGULAR).fontSize(11).text(safe, x + labelWidth + 6, y - 1, {
      width: valueWidth,
      lineBreak: true,
    });

    const blockHeight = doc.heightOfString(safe || " ", {
      width: valueWidth,
      lineGap: 0,
    });

    return y + Math.max(14, blockHeight) + 7;
  };

  const drawFieldPair = (leftLabel, leftValue, rightLabel, rightValue, y) => {
    const nextLeft = drawField(leftLabel, leftValue, leftX, y, colWidth);
    const nextRight = drawField(rightLabel, rightValue, rightX, y, colWidth);
    return Math.max(nextLeft, nextRight);
  };

  const drawFlightPaxRow = (x, y, width) => {
    const valueWidth = Math.max(40, width - labelWidth - 6);

    doc.font(FONT_BOLD).fontSize(11).text("Fly Code:", x, y, {
      continued: true,
      width: valueWidth,
      lineBreak: false,
    });
    doc.font(FONT_REGULAR).fontSize(11).text(` ${String(data.FLY_CODE ?? "")}    `, {
      continued: true,
      lineBreak: false,
    });
    doc.font(FONT_BOLD).fontSize(11).text("Pax:", {
      continued: true,
      lineBreak: false,
    });
    doc.font(FONT_REGULAR).fontSize(11).text(` ${String(data.PAX ?? "")}    `, {
      continued: true,
      lineBreak: false,
    });
    doc.font(FONT_BOLD).fontSize(11).text("Adult:", {
      continued: true,
      lineBreak: false,
    });
    doc.font(FONT_REGULAR).fontSize(11).text(` ${String(data.ADULT ?? "")}    `, {
      continued: true,
      lineBreak: false,
    });
    doc.font(FONT_BOLD).fontSize(11).text("Ch/Inf:", {
      continued: true,
      lineBreak: false,
    });
    doc.font(FONT_REGULAR).fontSize(11).text(` ${String(data.CH_INF ?? "")}`);

    const blockHeight = doc.heightOfString(
      `Fly Code: ${String(data.FLY_CODE ?? "")}    Pax: ${String(data.PAX ?? "")}    Adult: ${String(data.ADULT ?? "")}    Ch/Inf: ${String(data.CH_INF ?? "")}`,
      { width: valueWidth, lineGap: 0 },
    );

    return y + Math.max(14, blockHeight) + 7;
  };

  let y = 42;
  doc.font(FONT_REGULAR).fontSize(11).text(data.COMPANY_NAME, leftX, y);
  y += 15;
  doc.text(data.COMPANY_LINE1, leftX, y);
  y += 15;
  doc.text(data.COMPANY_WEB, leftX, y);
  y += 15;
  doc.text(data.COMPANY_GNTO, leftX, y);
  y += 15;
  doc.text(data.COMPANY_VAT, leftX, y);
  y += 15;
  doc.text(data.COMPANY_TEL, leftX, y);
  y += 15;
  doc.text(data.COMPANY_EMAIL, leftX, y);

  doc
    .font(FONT_BOLD)
    .fontSize(12)
    .text(`A/A: ${data.AA}`, rightX, 42, { width: colWidth, align: "right" });

  y = 170;
  y = drawField("Type", data.TYPE, leftX, y, contentWidth);
  y = drawFieldPair("Date", data.THE_DATE, "Time", data.TIME, y);
  y = drawField("From", data.FROM, leftX, y, contentWidth);
  y = drawFieldPair("To", data.TO, "Area", data.AREA, y);
  y = drawField("Hotel", data.HOTEL, leftX, y, contentWidth);
  y = drawFlightPaxRow(leftX, y, contentWidth);
  y = drawField("Customer Name", data.THE_NAME, leftX, y, contentWidth);
  y = drawField("Fly Company", data.FLY_COMPANY, leftX, y, contentWidth);
  drawField("Info", data.INFO, leftX, y, contentWidth);
}
