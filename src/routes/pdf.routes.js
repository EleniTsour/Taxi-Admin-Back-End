import { Router } from "express";
import PDFDocument from "pdfkit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireAuth } from "../auth.js";
import { MAX_EXPORT_PDF_ROWS, fetchAllMatchingRides } from "../rideSearch.js";
import { buildPdfBuffer, buildCombinedVoucherPdfBuffer, toVoucherData } from "../exportArtifacts.js";
import { renderVoucherPage } from "../pdfVoucher.js";

const router = Router();
const DEFAULT_NAME_TAG_LOGO_URL = "https://versa-reg.eu/versa-logo.png";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

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

function streamCombinedVoucherPdf(res, rows, filename) {
  streamPdf(res, filename, (doc) => {
    rows.map((ride) => toVoucherData(ride)).forEach((voucher, index) => {
      if (index > 0) doc.addPage();
      renderVoucherPage(doc, voucher);
    });
  });
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
 * Legacy/manual route: Search / Reports now uses the queued /exports flow instead.
 * TODO: remove this route after the queued /exports flow is verified in production.
 */
router.post("/vouchers", requireAuth, async (req, res) => {
  console.warn("Legacy export route used: POST /pdf/vouchers");
  const rides = Array.isArray(req.body) ? req.body : req.body?.rides;
  if (!Array.isArray(rides) || rides.length === 0) {
    return res.status(400).json({ error: "Body must contain a non-empty rides array." });
  }

  streamCombinedVoucherPdf(res, rides, `vouchers_${rides.length}.pdf`);
});

/**
 * GET /pdf/vouchers?from=...&to=...&tour_oper=...&driver=...&sortBy=...&sortDir=...
 * Returns one PDF with one voucher per page for all matching rides.
 * Legacy/manual route: Search / Reports now uses the queued /exports flow instead.
 * TODO: remove this route after the queued /exports flow is verified in production.
 */
router.get("/vouchers", requireAuth, async (req, res) => {
  console.warn("Legacy export route used: GET /pdf/vouchers");
  try {
    const result = await fetchAllMatchingRides(req.query, MAX_EXPORT_PDF_ROWS);
    streamCombinedVoucherPdf(res, result.rows, `vouchers_${result.rows.length}.pdf`);
  } catch (err) {
    const status = Number(err?.status || 500);
    return res.status(status).json({
      error: err?.message || "Could not generate combined PDF.",
      total: err?.total ?? undefined,
      limit: err?.limit ?? MAX_EXPORT_PDF_ROWS,
    });
  }
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
