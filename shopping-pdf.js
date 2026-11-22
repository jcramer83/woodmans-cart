// One-page-or-more in-store list with thumbnail rows and real AcroForm checkboxes.
// The checkbox appearance is a normal box, so viewers that ignore forms still print one.

const fs = require("fs");
const path = require("path");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { priceAmount } = require("./store-layout");

const ASSETS_DIR = path.join(__dirname, "assets");
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 36;
const HEADER_H = 86;
const FOOTER_H = 34;
const RED = rgb(183 / 255, 28 / 255, 28 / 255);
const INK = rgb(0.12, 0.12, 0.13);
const MUTED = rgb(0.38, 0.38, 0.42);
const RULE = rgb(0.86, 0.84, 0.82);
const PAPER = rgb(0.985, 0.978, 0.965);

function pdfSafe(text) {
  return String(text == null ? "" : text)
    .replace(/\u2019/g, "'")
    .replace(/\u2018/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00A0/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function money(amount) {
  return "$" + (Math.round(amount * 100) / 100).toFixed(2);
}

function resolveAsset(urlPath) {
  if (typeof urlPath !== "string" || !urlPath.startsWith("/assets/")) return null;
  let rel = urlPath.slice("/assets/".length).split("?")[0];
  try { rel = decodeURIComponent(rel); } catch (err) { return null; }
  if (!rel || rel.includes("\0")) return null;
  const full = path.resolve(ASSETS_DIR, rel);
  if (full !== ASSETS_DIR && !full.startsWith(ASSETS_DIR + path.sep)) return null;
  return full;
}

async function loadImageBytes(url) {
  const asset = resolveAsset(url);
  if (asset) {
    try { return fs.readFileSync(asset); } catch (err) { return null; }
  }
  if (typeof url !== "string" || !url.startsWith("https://")) return null;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "WoodmansCart/shopping-list" },
    });
    if (!response.ok) return null;
    if (!String(response.url || "").startsWith("https://")) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 1500000) return null;
    return bytes;
  } catch (err) {
    return null;
  }
}

function sniffImage(bytes) {
  if (!bytes || bytes.length < 8) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  return null;
}

function wrapText(text, font, size, maxWidth) {
  const words = pdfSafe(text).split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? line + " " + word : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word;
    }
    if (lines.length === 2) break;
  }
  if (lines.length < 2 && line) lines.push(line);
  return lines.slice(0, 2);
}

function groupItems(items) {
  const groups = [];
  (items || []).forEach(function (item) {
    let group = groups[groups.length - 1];
    const key = item.sectionKey || item.sectionLabel || "other";
    if (!group || group.key !== key) {
      group = { key: key, label: item.sectionLabel || "Other", items: [] };
      groups.push(group);
    }
    group.items.push(item);
  });
  return groups;
}

async function buildShoppingPdf(trip) {
  const items = (trip && trip.items) || [];
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const form = doc.getForm();

  const cache = new Map();
  async function embed(url) {
    if (!url) return null;
    if (cache.has(url)) return cache.get(url);
    const pending = (async function () {
      const bytes = await loadImageBytes(url);
      const kind = sniffImage(bytes);
      if (!kind) return null;
      try {
        return kind === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      } catch (err) {
        return null;
      }
    })();
    cache.set(url, pending);
    return pending;
  }

  await Promise.all(items.map(function (item) { return embed(item.image); }));

  const checkedCount = items.filter(function (item) { return item.checked; }).length;
  const total = items.reduce(function (sum, item) {
    return sum + priceAmount(item.price) * (item.quantity || 1);
  }, 0);
  const when = new Date();
  const dateLabel = when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  const pages = [];
  function drawChrome(page, pageIndex, pageCount) {
    page.drawRectangle({ x: 0, y: PAGE_H - HEADER_H, width: PAGE_W, height: HEADER_H, color: RED });
    page.drawText("Woodman's", { x: MARGIN_X, y: PAGE_H - 34, size: 22, font: bold, color: rgb(1, 1, 1) });
    page.drawText(pdfSafe("In-store list - Racine - " + dateLabel), {
      x: MARGIN_X, y: PAGE_H - 54, size: 10, font: font, color: rgb(1, 0.9, 0.9),
    });
    page.drawText(pdfSafe(items.length + " items   ·   " + checkedCount + " checked   ·   Est. " + money(total)), {
      x: MARGIN_X, y: PAGE_H - 70, size: 10, font: font, color: rgb(1, 1, 1),
    });
    page.drawText("Racine walk order", {
      x: MARGIN_X, y: 16, size: 9, font: font, color: MUTED,
    });
    if (pageCount) {
      const label = pageIndex + " / " + pageCount;
      const width = font.widthOfTextAtSize(label, 9);
      page.drawText(label, { x: PAGE_W - MARGIN_X - width, y: 16, size: 9, font: font, color: MUTED });
    }
  }

  let page = doc.addPage([PAGE_W, PAGE_H]);
  pages.push(page);
  drawChrome(page, 1, 0);
  let y = PAGE_H - HEADER_H - 18;

  function newPage() {
    page = doc.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    drawChrome(page, pages.length, 0);
    y = PAGE_H - HEADER_H - 18;
  }

  function ensure(height) {
    if (y - height < FOOTER_H) newPage();
  }

  const groups = groupItems(items);
  let fieldIndex = 0;
  const textX = MARGIN_X + 78;
  const textW = PAGE_W - MARGIN_X - textX;

  if (!items.length) {
    page.drawText("The shopping list is empty.", { x: MARGIN_X, y: y - 20, size: 12, font: font, color: INK });
  }

  for (const group of groups) {
    ensure(22 + 56);
    page.drawText(pdfSafe(group.label).toUpperCase(), {
      x: MARGIN_X, y: y - 12, size: 10, font: bold, color: RED,
    });
    const countLabel = String(group.items.length);
    const countW = font.widthOfTextAtSize(countLabel, 10);
    page.drawText(countLabel, {
      x: PAGE_W - MARGIN_X - countW, y: y - 12, size: 10, font: font, color: MUTED,
    });
    y -= 18;
    page.drawLine({
      start: { x: MARGIN_X, y: y },
      end: { x: PAGE_W - MARGIN_X, y: y },
      thickness: 0.8,
      color: RULE,
    });
    y -= 8;

    for (const item of group.items) {
      const nameLines = wrapText(item.name, bold, 11, textW);
      const rowH = nameLines.length > 1 ? 62 : 54;
      ensure(rowH + 4);
      const rowTop = y;
      const rowBottom = y - rowH;

      if ((fieldIndex % 2) === 1) {
        page.drawRectangle({
          x: MARGIN_X - 6,
          y: rowBottom,
          width: PAGE_W - MARGIN_X * 2 + 12,
          height: rowH,
          color: PAPER,
        });
      }

      const box = 14;
      const field = form.createCheckBox("item_" + fieldIndex);
      field.addToPage(page, {
        x: MARGIN_X,
        y: rowBottom + (rowH - box) / 2,
        width: box,
        height: box,
        borderWidth: 1.25,
        borderColor: rgb(0.25, 0.25, 0.27),
        backgroundColor: rgb(1, 1, 1),
      });
      if (item.checked) field.check();
      fieldIndex += 1;

      const image = await embed(item.image);
      const imgSize = 40;
      const imgY = rowBottom + (rowH - imgSize) / 2;
      if (image) {
        page.drawImage(image, { x: MARGIN_X + 24, y: imgY, width: imgSize, height: imgSize });
      } else {
        page.drawRectangle({
          x: MARGIN_X + 24, y: imgY, width: imgSize, height: imgSize, color: rgb(0.93, 0.91, 0.88),
        });
        const initial = pdfSafe(item.name).slice(0, 1).toUpperCase() || "?";
        const initialW = bold.widthOfTextAtSize(initial, 14);
        page.drawText(initial, {
          x: MARGIN_X + 24 + (imgSize - initialW) / 2,
          y: imgY + 13,
          size: 14,
          font: bold,
          color: MUTED,
        });
      }

      let textY = rowTop - 16;
      nameLines.forEach(function (line) {
        page.drawText(line, { x: textX, y: textY, size: 11, font: bold, color: INK });
        textY -= 13;
      });

      const shelf = item.shelfLabel || "";
      const where = item.sectionLabel && item.aisle == null ? item.sectionLabel : (item.sectionLabel || "");
      const place = [where, shelf].filter(function (part, index, all) {
        return part && all.indexOf(part) === index;
      }).join(" - ");
      const qty = "Qty " + (item.quantity || 1);
      const price = item.price ? pdfSafe(item.price) : "";
      const size = item.size ? pdfSafe(item.size) : "";
      const meta = [place, qty, price, size].filter(Boolean).join(" - ");
      page.drawText(pdfSafe(meta).slice(0, 110), {
        x: textX,
        y: rowBottom + 10,
        size: 9,
        font: font,
        color: MUTED,
      });

      y = rowBottom - 2;
    }
    y -= 8;
  }

  pages.forEach(function (printed, index) {
    const label = (index + 1) + " / " + pages.length;
    const width = font.widthOfTextAtSize(label, 9);
    printed.drawText(label, { x: PAGE_W - MARGIN_X - width, y: 16, size: 9, font: font, color: MUTED });
  });

  doc.setTitle("Woodman's in-store shopping list");
  doc.setAuthor("Woodman's Cart");
  return Buffer.from(await doc.save());
}

module.exports = { buildShoppingPdf, resolveAsset, loadImageBytes };
