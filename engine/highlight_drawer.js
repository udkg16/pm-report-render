const fs = require("fs");
const path = require("path");
const { rgb, BlendMode } = require("pdf-lib");
const { getNumberColor, getBodyHighlightColor, AI_HIGHLIGHT_COLOR, AI_HIGHLIGHT_ALPHA } = require("./palette.js");

function roundedRectSvg(w, h, r) {
  return `M ${r} 0 L ${w - r} 0 A ${r} ${r} 0 0 1 ${w} ${r} L ${w} ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} L ${r} ${h} A ${r} ${r} 0 0 1 0 ${h - r} L 0 ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
}

function drawPillBadge(page, x, y, w, h, options = {}) {
  const r = h / 2;
  const k = r * 0.552284749831;
  const svg = `M ${r} 0 L ${w - r} 0 C ${w - r + k} 0 ${w} ${r - k} ${w} ${r} C ${w} ${r + k} ${w - r + k} ${h} ${w - r} ${h} L ${r} ${h} C ${r - k} ${h} 0 ${r + k} 0 ${r} C 0 ${r - k} ${r - k} 0 ${r} 0 Z`;
  page.drawSvgPath(svg, {
    x: x,
    y: y + h,
    ...options,
  });
}

function drawMarginBadges(page, boxes, pageHeight, assets) {
  // 1. 按 sourceIndex 与 y 分组
  const sourceRows = {};
  for (const b of boxes) {
    if (!sourceRows[b.sourceIndex]) {
      sourceRows[b.sourceIndex] = {};
    }
    const yCenter = (b.y0 + b.y1) / 2.0;
    const yKey = Math.round(b.y0 * 2) / 2.0;
    if (!sourceRows[b.sourceIndex][yKey]) {
      sourceRows[b.sourceIndex][yKey] = {
        yTop: b.y0,
        xLeft: b.x0,
        yCenter: yCenter,
      };
    }
  }

  const lineGroups = {};
  for (const [srcIdxStr, rowMap] of Object.entries(sourceRows)) {
    const srcIdx = parseInt(srcIdxStr, 10);
    const keys = Object.keys(rowMap).map(Number).sort((a, b) => a - b);
    const kept = [];
    for (const k of keys) {
      if (kept.length === 0) {
        kept.push(k);
      } else if (rowMap[k].yTop - rowMap[kept[kept.length - 1]].yTop >= 100.0) {
        kept.push(k);
      }
    }
    for (const k of kept) {
      const info = rowMap[k];
      if (!lineGroups[k]) lineGroups[k] = [];
      lineGroups[k].push({
        sourceIndex: srcIdx,
        xLeft: info.xLeft,
        yCenter: info.yCenter,
      });
    }
  }

  for (const slots of Object.values(lineGroups)) {
    slots.sort((a, b) => a.xLeft - b.xLeft);
    for (let slotIdx = 0; slotIdx < Math.min(slots.length, 3); slotIdx++) {
      const s = slots[slotIdx];
      const bx0 = 7.48 + slotIdx * (17.72 + 2.0);
      const yCenter = s.yCenter + slotIdx * 2.77;
      const yTop = yCenter - 15.51 / 2.0;
      const badgeH = 15.51;
      const badgeW = 17.72;

      // 转换为 PDF 坐标 (左下角原点)
      const pdfY = pageHeight - yTop - badgeH;
      const satColor = getNumberColor(s.sourceIndex);

      drawPillBadge(page, bx0, pdfY, badgeW, badgeH, {
        color: satColor,
      });

      const numStr = String(s.sourceIndex);
      let digitW = 3.85;
      if (numStr.length >= 2) {
        digitW = 7.95;
      }
      const tx = bx0 + badgeW / 2.0 - digitW / 2.0;
      const textPdfY = pageHeight - (yCenter + 2.5);

      page.drawText(numStr, {
        x: tx,
        y: textPdfY,
        size: 7.0,
        font: assets.fontNotoSb,
        color: rgb(1, 1, 1),
      });
    }
  }
}

/**
 * 在目标 PDFPage 上直接绘制高亮、页眉、页脚与边距徽章
 */
function drawPageHighlights(page, boxes, isAI, pageNum, totalPages, section, submissionID, assets) {
  const { width, height } = page.getSize();

  // 1. 绘制 Header 与 Footer
  if (assets.coverRenderer) {
    assets.coverRenderer.drawHeader(page, assets, pageNum, totalPages, section, submissionID);
    assets.coverRenderer.drawFooter(page, assets, pageNum, totalPages, section, submissionID);
  }

  if (!boxes || boxes.length === 0) return;

  // 2. 绘制高亮矩形 (PDF 坐标原点在左下角)
  for (const b of boxes) {
    const boxW = b.x1 - b.x0;
    const boxH = b.y1 - b.y0;
    if (boxW <= 0 || boxH <= 0) continue;

    const pdfY = height - b.y0 - boxH;

    if (isAI) {
      page.drawRectangle({
        x: b.x0,
        y: pdfY,
        width: boxW,
        height: boxH,
        color: AI_HIGHLIGHT_COLOR,
        opacity: AI_HIGHLIGHT_ALPHA,
        blendMode: BlendMode.Multiply,
      });
    } else {
      const hlColor = getBodyHighlightColor(b.sourceIndex);
      page.drawRectangle({
        x: b.x0,
        y: pdfY,
        width: boxW,
        height: boxH,
        color: hlColor,
        opacity: 0.5,
        blendMode: BlendMode.Multiply,
      });
    }
  }

  // 3. 相似度报告正文绘制左侧 Margin 胶囊徽章
  if (!isAI) {
    drawMarginBadges(page, boxes, height, assets);
  }
}

module.exports = {
  drawPageHighlights,
};
