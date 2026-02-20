import { Router } from "express";
import PDFDocument from "pdfkit";
import { requireAuth } from "../auth.js";

const router = Router();

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

    doc.font("Helvetica-Bold").fontSize(10).text(`${label}:`, x, y, { width: labelWidth });

    doc.font("Helvetica").fontSize(11).text(safe, x + labelWidth + 6, y - 1, {
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

    doc.font("Helvetica-Bold").fontSize(11).text("Fly Code:", x, y, {
      continued: true,
      width: valueWidth,
      lineBreak: false,
    });
    doc.font("Helvetica").fontSize(11).text(` ${String(data.FLY_CODE ?? "")}    `, {
      continued: true,
      lineBreak: false,
    });
    doc.font("Helvetica-Bold").fontSize(11).text("Pax:", {
      continued: true,
      lineBreak: false,
    });
    doc.font("Helvetica").fontSize(11).text(` ${String(data.PAX ?? "")}    `, {
      continued: true,
      lineBreak: false,
    });
    doc.font("Helvetica-Bold").fontSize(11).text("Adult:", {
      continued: true,
      lineBreak: false,
    });
    doc.font("Helvetica").fontSize(11).text(` ${String(data.ADULT ?? "")}    `, {
      continued: true,
      lineBreak: false,
    });
    doc.font("Helvetica-Bold").fontSize(11).text("Ch/Inf:", {
      continued: true,
      lineBreak: false,
    });
    doc.font("Helvetica").fontSize(11).text(` ${String(data.CH_INF ?? "")}`);

    const blockHeight = doc.heightOfString(
      `Fly Code: ${String(data.FLY_CODE ?? "")}    Pax: ${String(data.PAX ?? "")}    Adult: ${String(data.ADULT ?? "")}    Ch/Inf: ${String(data.CH_INF ?? "")}`,
      { width: valueWidth, lineGap: 0 },
    );

    return y + Math.max(14, blockHeight) + 7;
  };

  let y = 42;
  doc.font("Helvetica").fontSize(11).text(data.COMPANY_NAME, leftX, y);
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
    .font("Helvetica-Bold")
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
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

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
    const info = await transporter.sendMail({
      from,
      to,
      subject: finalSubject,
      text: finalText,
      attachments: [
        {
          filename: `voucher_${data.AA || "ride"}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
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

export default router;
