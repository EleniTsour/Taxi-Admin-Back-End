import { Router } from "express";
import PDFDocument from "pdfkit";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireAuth } from "../auth.js";

const router = Router();
const DEFAULT_NAME_TAG_LOGO_URL = "https://versa-reg.eu/versa-logo.png";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function pickFirstExisting(paths = []) {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

const FONT_REGULAR =
  pickFirstExisting([
    path.resolve(MODULE_DIR, "../../assets/fonts/NotoSans-Regular.ttf"),
    path.resolve(MODULE_DIR, "../../assets/fonts/DejaVuSans.ttf"),
    "C:\\Windows\\Fonts\\arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
  ]) || "Helvetica";

const FONT_BOLD =
  pickFirstExisting([
    path.resolve(MODULE_DIR, "../../assets/fonts/NotoSans-Bold.ttf"),
    path.resolve(MODULE_DIR, "../../assets/fonts/DejaVuSans-Bold.ttf"),
    "C:\\Windows\\Fonts\\arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
  ]) || "Helvetica-Bold";

function toAsciiFilename(filename, fallback = "document.pdf") {
  const raw = String(filename ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!raw) return fallback;

  const normalized = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const safe = normalized
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);

  return safe || fallback;
}

function buildContentDispositionInline(filename) {
  const original = String(filename ?? "document.pdf").replace(/[\r\n]+/g, " ").trim() || "document.pdf";
  const ascii = toAsciiFilename(original, "document.pdf");
  const encoded = encodeURIComponent(original);
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function toVoucherData(ride = {}) {
  return {
    AA: ride["A/A"] ?? ride.AA ?? "",
    THE_DATE: ride.THE_DATE ?? ride.DATE ?? "",
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

function renderVoucherPage(doc, data) {
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

function streamPdf(res, filename, buildFn) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", buildContentDispositionInline(filename));

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 36, left: 28, right: 28, bottom: 36 },
  });

  doc.pipe(res);
  buildFn(doc);
  doc.end();
}

function buildPdfBuffer(buildFn) {
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

function streamLandscapePdf(res, filename, buildFn) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", buildContentDispositionInline(filename));

  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 28, left: 28, right: 28, bottom: 28 },
  });

  doc.pipe(res);
  buildFn(doc);
  doc.end();
}

function normalizeName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function renderNameTagPage(doc, name, logoBuffer = null) {
  const safeName = normalizeName(name);
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const contentHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;

  let fontSize = 96;
  doc.font(FONT_BOLD);
  while (fontSize > 24) {
    doc.fontSize(fontSize);
    const textHeight = doc.heightOfString(safeName, { width: contentWidth, align: "center" });
    if (textHeight <= contentHeight * 0.62) break;
    fontSize -= 4;
  }

  doc.fontSize(fontSize);
  const centeredTextHeight = doc.heightOfString(safeName, { width: contentWidth, align: "center" });
  const y = Math.max(doc.page.margins.top, (doc.page.height - centeredTextHeight) / 2);
  doc.text(safeName, doc.page.margins.left, y, { width: contentWidth, align: "center" });

  if (logoBuffer) {
    const logoMaxWidth = 180;
    const logoMaxHeight = 90;
    const logoX = doc.page.width - doc.page.margins.right - logoMaxWidth;
    const logoY = doc.page.height - doc.page.margins.bottom - logoMaxHeight;
    doc.image(logoBuffer, logoX, logoY, { fit: [logoMaxWidth, logoMaxHeight], align: "right", valign: "bottom" });
  }
}

async function fetchLogoBufferFromUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Logo URL returned ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (!buffer.length) {
    throw new Error("Logo image is empty.");
  }
  return buffer;
}

async function createMailerTransport() {
  let nodemailerModule;
  try {
    nodemailerModule = await import("nodemailer");
  } catch {
    const err = new Error("Email feature requires nodemailer. Run: cd backend && npm install nodemailer");
    err.status = 500;
    throw err;
  }

  const nodemailer = nodemailerModule.default;
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";

  if (!host) {
    const err = new Error("SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS.");
    err.status = 400;
    throw err;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
  });
}

function escapeIcsText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function toIcsDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;

  const european = raw.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (european) return `${european[3]}${european[2]}${european[1]}`;

  return null;
}

function toIcsTime(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const timeMatch = raw.match(/^(\d{2}):(\d{2})/);
  if (!timeMatch) return null;
  return `${timeMatch[1]}${timeMatch[2]}00`;
}

function buildVoucherCalendarIcs(data) {
  const ymd = toIcsDate(data.THE_DATE);
  if (!ymd) return null;

  const hhmmss = toIcsTime(data.TIME);
  const uidBase = String(data.AA || `${Date.now()}`).replace(/\s+/g, "_");
  const dtStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

  const summary = data.THE_NAME
    ? `Transfer - ${data.THE_NAME}`
    : "Transfer Reservation";
  const location = [data.FROM, data.TO].filter(Boolean).join(" -> ");
  const descriptionLines = [
    data.TYPE ? `Type: ${data.TYPE}` : "",
    data.AA ? `A/A: ${data.AA}` : "",
    data.HOTEL ? `Hotel: ${data.HOTEL}` : "",
    data.FLY_CODE ? `Fly Code: ${data.FLY_CODE}` : "",
    data.INFO ? `Info: ${data.INFO}` : "",
  ].filter(Boolean);

  let dtStartLine = `DTSTART;VALUE=DATE:${ymd}`;
  let dtEndLine = `DTEND;VALUE=DATE:${ymd}`;
  if (hhmmss) {
    const startHour = Number(hhmmss.slice(0, 2));
    const startMin = Number(hhmmss.slice(2, 4));
    const endDate = new Date(Date.UTC(2026, 0, 1, startHour, startMin));
    endDate.setUTCMinutes(endDate.getUTCMinutes() + 90);
    const endTime = `${pad2(endDate.getUTCHours())}${pad2(endDate.getUTCMinutes())}00`;
    dtStartLine = `DTSTART:${ymd}T${hhmmss}`;
    dtEndLine = `DTEND:${ymd}T${endTime}`;
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Versa Tours//Voucher Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uidBase}@versa-reg.eu`,
    `DTSTAMP:${dtStamp}`,
    dtStartLine,
    dtEndLine,
    `SUMMARY:${escapeIcsText(summary)}`,
    location ? `LOCATION:${escapeIcsText(location)}` : "",
    descriptionLines.length ? `DESCRIPTION:${escapeIcsText(descriptionLines.join("\n"))}` : "",
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);

  return `${lines.join("\r\n")}\r\n`;
}

/**
 * POST /pdf/voucher
 * Body: single ride object
 */
router.post("/voucher", async (req, res) => {
  const data = toVoucherData(req.body ?? {});
  streamPdf(res, `voucher_${data.AA || "ride"}.pdf`, (doc) => {
    renderVoucherPage(doc, data);
  });
});

/**
 * POST /pdf/vouchers
 * Body: { rides: [...] } or [...]
 * Returns one PDF with one voucher per page.
 */
router.post("/vouchers", async (req, res) => {
  const rides = Array.isArray(req.body) ? req.body : req.body?.rides;
  if (!Array.isArray(rides) || rides.length === 0) {
    return res.status(400).json({ error: "Body must contain a non-empty rides array." });
  }

  const vouchers = rides.map((ride) => toVoucherData(ride));
  streamPdf(res, `vouchers_${vouchers.length}.pdf`, (doc) => {
    vouchers.forEach((voucher, index) => {
      if (index > 0) doc.addPage();
      renderVoucherPage(doc, voucher);
    });
  });
});

/**
 * POST /pdf/voucher-email
 * Body: { ride: {...}, to: "email@domain.com", subject?: "...", text?: "..." }
 */
router.post("/voucher-email", requireAuth, async (req, res) => {
  const to = String(req.body?.to ?? "").trim();
  const ride = req.body?.ride ?? {};
  const subject = String(req.body?.subject ?? "").trim();
  const text = String(req.body?.text ?? "").trim();
  const includeCalendar = Boolean(req.body?.includeCalendar);

  if (!to) {
    return res.status(400).json({ error: "Recipient email is required." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ error: "Recipient email is invalid." });
  }

  try {
    const data = toVoucherData(ride);
    const pdfBuffer = await buildPdfBuffer((doc) => {
      renderVoucherPage(doc, data);
    });

    const transporter = await createMailerTransport();
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    if (!from) {
      return res.status(400).json({ error: "SMTP_FROM (or SMTP_USER) is required." });
    }

    const finalSubject = subject || `Voucher${data.AA ? ` A/A ${data.AA}` : ""}`;
    const finalText = text || `Attached is your voucher${data.AA ? ` (A/A ${data.AA})` : ""}.`;
    const attachments = [
      {
        filename: `voucher_${data.AA || "ride"}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ];

    if (includeCalendar) {
      const icsContent = buildVoucherCalendarIcs(data);
      if (!icsContent) {
        return res.status(400).json({ error: "Calendar invite requires a valid date in the ride." });
      }

      attachments.push({
        filename: `voucher_${data.AA || "ride"}.ics`,
        content: Buffer.from(icsContent, "utf8"),
        contentType: "text/calendar; charset=utf-8; method=REQUEST",
      });
    }

    const info = await transporter.sendMail({
      from,
      to,
      subject: finalSubject,
      text: finalText,
      attachments,
    });

    return res.json({
      ok: true,
      to,
      messageId: info?.messageId ?? null,
    });
  } catch (err) {
    const status = Number(err?.status || 500);
    return res.status(status).json({ error: err?.message || "Could not send voucher email." });
  }
});

/**
 * POST /pdf/name-tag
 * Body: { name: "Customer Name" }
 */
router.post("/name-tag", requireAuth, async (req, res) => {
  const name = normalizeName(req.body?.name ?? req.body?.THE_NAME);
  if (!name) {
    return res.status(400).json({ error: "Customer name is required." });
  }

  return streamLandscapePdf(res, `name_tag_${name.replace(/\s+/g, "_")}.pdf`, (doc) => {
    renderNameTagPage(doc, name);
  });
});

/**
 * POST /pdf/name-tag-logo
 * Body: { name: "Customer Name", logoUrl?: "https://..." }
 */
router.post("/name-tag-logo", requireAuth, async (req, res) => {
  const name = normalizeName(req.body?.name ?? req.body?.THE_NAME);
  if (!name) {
    return res.status(400).json({ error: "Customer name is required." });
  }

  const logoUrl = String(req.body?.logoUrl ?? process.env.NAME_TAG_LOGO_URL ?? DEFAULT_NAME_TAG_LOGO_URL).trim();
  if (!logoUrl) {
    return res.status(400).json({ error: "Logo URL is required." });
  }

  try {
    const logoBuffer = await fetchLogoBufferFromUrl(logoUrl);
    return streamLandscapePdf(res, `name_tag_logo_${name.replace(/\s+/g, "_")}.pdf`, (doc) => {
      renderNameTagPage(doc, name, logoBuffer);
    });
  } catch (err) {
    return res.status(400).json({ error: `Could not load logo: ${err.message}` });
  }
});

export default router;
