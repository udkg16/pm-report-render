const fs = require("fs");
const path = require("path");
const { rgb, PDFName, PDFString } = require("pdf-lib");
const {
  TIICoverRenderer,
  PAGE_WIDTH,
  PAGE_HEIGHT,
  formatDT,
  formatSize,
  formatNumber,
  formatSubmissionID,
} = require("./cover.js");

const LEFT_MARGIN = 36.0;
const RIGHT_MARGIN = 576.0;

const COLOR_HEADING = rgb(25 / 255, 25 / 255, 25 / 255);
const COLOR_LABEL = rgb(99 / 255, 99 / 255, 99 / 255);
const COLOR_LINE = rgb(204 / 255, 204 / 255, 204 / 255);
const COLOR_FLAG_BOX = rgb(208 / 255, 232 / 255, 249 / 255); // #D0E8F9

// 官方 4 色循环配色 (红、蓝、绿、紫)
const TOP_SOURCE_PALETTE = [
  // 1: 红/品红 (#CB1375, 淡底 #FEDCE7)
  { sat: rgb(0.7961, 0.0745, 0.4588), pale: rgb(0.9961, 0.8627, 0.9059) },
  // 2: 蓝 (#215DC6, 淡底 #D6E5FB)
  { sat: rgb(0.1294, 0.3647, 0.7765), pale: rgb(0.8392, 0.8980, 0.9843) },
  // 3: 绿 (#007445, 淡底 #C1ECDF)
  { sat: rgb(0.0000, 0.4549, 0.2706), pale: rgb(0.7569, 0.9255, 0.8745) },
  // 4: 紫 (#7432E7, 淡底 #ECDFFE)
  { sat: rgb(0.4549, 0.1961, 0.9059), pale: rgb(0.9255, 0.8745, 0.9961) },
];

function getSourceColor(index1Based) {
  let idx = (index1Based - 1) % TOP_SOURCE_PALETTE.length;
  if (idx < 0) idx += TOP_SOURCE_PALETTE.length;
  return TOP_SOURCE_PALETTE[idx];
}

// 胶囊药丸绘制：严格按照官方贝塞尔曲线构建全半圆胶囊
// h 为胶囊高度，两端半径 r = h / 2
function drawPill(page, x, y, w, h, options = {}) {
  const r = h / 2;
  const k = r * 0.552284749831; // 贝塞尔控制点系数
  // SVG 路径绘制药丸: 起点在顶部平线左端 (r, 0)，向右画线到 (w - r, 0)，右半圆到 (w - r, h)，向左到底部 (r, h)，左半圆闭合到 (r, 0)
  const path = `M ${r} 0 L ${w - r} 0 C ${w - r + k} 0 ${w} ${r - k} ${w} ${r} C ${w} ${r + k} ${w - r + k} ${h} ${w - r} ${h} L ${r} ${h} C ${r - k} ${h} 0 ${r + k} 0 ${r} C 0 ${r - k} ${r - k} 0 ${r} 0 Z`;
  page.drawSvgPath(path, {
    x: x,
    y: y + h,
    ...options,
  });
}

// 官方 Match Groups 底色圆圈路径定义
// 官网原生路径：在原点 (0, 0) 从 (0, 0) 到 (0.5, 0) 到右弧 (6.5, 6) 到 (0.5, 12) 到 (0, 12) 到左弧 (-6, 6) 回到 (0, 0)
// 在反向坐标系（1 0 0 -1 0 0 cm，y 向下）下：
// 相当于原坐标系中：X 范围 [anchorX - 6, anchorX + 6.5]，宽度 12.5，几何中心 X = anchorX + 0.25
// Y 范围 [anchorY - 12, anchorY]，高度 12.0，几何中心 Y = anchorY - 6
// 官方 anchor:
// Page 2: anchorX = 42.0, anchorY 依次为 607.5, 582.5, 557.5, 532.5 (即 textY + 8.0)
// Page 3: anchorX = 42.0, anchorY 依次为 716.0, 691.0, 666.0, 641.0 (即 textY + 8.0)
function drawOfficialMGCircle(page, anchorX, anchorY, color) {
  // SVG Path 等价表达官方原生贝塞尔路径（SVG y 向下，完美契合 1 0 0 -1）：
  // m 0 0 l 0.5 0 c 3.3137 0 6 2.6863 6 6 c 0 3.3137 -2.6863 6 -6 6 l -0.5 0 c -3.3137 0 -6 -2.6863 -6 -6 c 0 -3.3137 2.6863 -6 6 -6 Z
  const path = "M 0 0 L 0.5 0 C 3.8137 0 6.5 2.6863 6.5 6 C 6.5 9.3137 3.8137 12 0.5 12 L 0 12 C -3.3137 12 -6 9.3137 -6 6 C -6 2.6863 -3.3137 0 0 0 Z";
  page.drawSvgPath(path, {
    x: anchorX,
    y: anchorY, // 在 drawSvgPath 中，默认 y 为基点向上或向下，但我们也可以用 drawCircle 或 drawSvgPath
    color: color,
  });
}

function summarizeMatchGroups(taggedView) {
  return ["!cited,!quoted", "cited,!quoted", "!cited,quoted", "cited,quoted"].map(tag => {
    const data = taggedView?.[tag];
    if (data == null) return {count: 0, percent: 0};
    if (typeof data !== "object" || Array.isArray(data)) throw new Error(`Invalid match group data: ${tag}`);
    const percent = data.overallMatchPercentage ?? 0;
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new Error(`Invalid match group percentage: ${tag}`);
    }
    const aggregates = data.matchAggregates ?? [];
    if (!Array.isArray(aggregates)) throw new Error(`Invalid match group aggregates: ${tag}`);
    let count = 0;
    for (const aggregate of aggregates) {
      if (aggregate != null && (typeof aggregate !== "object" || Array.isArray(aggregate))) {
        throw new Error(`Invalid match group aggregate: ${tag}`);
      }
      const sources = aggregate?.matchSources ?? [];
      if (!Array.isArray(sources)) throw new Error(`Invalid match group sources: ${tag}`);
      for (const source of sources) {
        if (source != null && (typeof source !== "object" || Array.isArray(source))) {
          throw new Error(`Invalid match group source: ${tag}`);
        }
        const groups = source?.matchGroups ?? [];
        if (!Array.isArray(groups)) throw new Error(`Invalid match groups: ${tag}`);
        count += groups.filter(group => group != null).length;
      }
    }
    return {count, percent};
  });
}

function roundedRectSvg(w, h, r) {
  return `M ${r} 0 L ${w - r} 0 A ${r} ${r} 0 0 1 ${w} ${r} L ${w} ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} L ${r} ${h} A ${r} ${r} 0 0 1 0 ${h - r} L 0 ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
}

function drawRoundedRect(page, x, y, w, h, r, options = {}) {
  const path = roundedRectSvg(w, h, r);
  page.drawSvgPath(path, {
    x: x,
    y: y + h,
    ...options,
  });
}

class TIISimilarityCoverRenderer extends TIICoverRenderer {
  constructor(resDir) {
    super(resDir);
  }

  async loadSimAssets(doc) {
    const baseAssets = await this.loadAssets(doc);

    // 加载 Match Groups 图标与 Top Sources 图标
    const loadPng = (filename) => {
      const p = path.join(this.resDir, filename);
      if (fs.existsSync(p)) {
        return doc.embedPng(fs.readFileSync(p));
      }
      return null;
    };

    const filterChevron = await loadPng("filter-chevron.png");
    const mgIcons = [
      await loadPng("mg-not-cited-or-quoted.png"),
      await loadPng("mg-missing-quotations.png"),
      await loadPng("mg-missing-citation.png"),
      await loadPng("mg-cited-and-quoted.png"),
    ];

    const tsIcons = {
      internet: await loadPng("ts-internet.png"),
      publications: await loadPng("ts-publications.png"),
      submitted: await loadPng("ts-submitted.png"),
    };

    return {
      ...baseAssets,
      filterChevron,
      mgIcons,
      tsIcons,
    };
  }

  /**
   * 渲染相似度报告所有封面页：
   * Page 1: Cover Page
   * Page 2: Integrity Overview
   * Page 3+: Top Sources 列表
   */
  async renderSimilarityCoverPages(doc, subMeta, repMeta, aggregates, submissionID, totalPages, matchGroups) {
    // 1. 第 1 页 Cover Page
    await this.renderCoverPage(doc, subMeta, submissionID, totalPages);

    const assets = await this.loadSimAssets(doc);

    // 2. 第 2 页 Integrity Overview
    const page2 = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.drawHeader(page2, assets, 2, totalPages, "Integrity Overview", submissionID);

    const overall = parseInt(repMeta && repMeta.overallMatchPercentage, 10) || 0;

    // 大标题: 17pt Lexend
    // y=720 附近
    page2.drawText(`${overall}%`, {
      x: LEFT_MARGIN,
      y: 720.0,
      size: 17.0,
      font: assets.fontLexend,
      color: COLOR_HEADING,
    });

    page2.drawText("Overall Similarity", {
      x: 71.0,
      y: 720.0,
      size: 17.0,
      font: assets.fontLexend,
      color: COLOR_HEADING,
    });

    page2.drawText("The combined total of all matches, including overlapping sources, for each database.", {
      x: LEFT_MARGIN,
      y: 704.5,
      size: 7.0,
      font: assets.fontNotoReg,
      color: COLOR_LABEL,
    });

    // 绘制 Filtered 区块 (如果有)
    let filterShift = 0;
    const filterRows = [];
    if (subMeta) {
      if (Number(subMeta.bibliography_percentage) > 0) {
        filterRows.push({ label: "Bibliography", pct: Number(subMeta.bibliography_percentage) });
      }
      if (Number(subMeta.quote_percentage) > 0) {
        filterRows.push({ label: "Quoted Text", pct: Number(subMeta.quote_percentage) });
      }
    }

    if (filterRows.length > 0) {
      let fTop = 680.5;
      page2.drawText("Filtered from the Report", {
        x: LEFT_MARGIN,
        y: fTop,
        size: 10.0,
        font: assets.fontNotoSb,
        color: COLOR_HEADING,
      });

      for (let i = 0; i < filterRows.length; i++) {
        const rowY = 662.5 - i * 14.0;
        if (assets.filterChevron) {
          page2.drawImage(assets.filterChevron, {
            x: 39.0,
            y: 663.5 - i * 14.0,
            width: 2.0,
            height: 3.0,
          });
        }
        page2.drawText(filterRows[i].label, {
          x: 48.0,
          y: rowY,
          size: 7.0,
          font: assets.fontNotoReg,
          color: COLOR_HEADING,
        });
      }

      page2.drawLine({
        start: { x: LEFT_MARGIN, y: 643.5 },
        end: { x: RIGHT_MARGIN, y: 643.5 },
        thickness: 0.5,
        color: COLOR_LINE,
      });
    }

    // Match Groups 栏 (左栏)
    const mgTopY = 619.5;
    this.drawMatchGroupsBlock(page2, assets, mgTopY, matchGroups);

    // Top Sources 栏 (右栏)
    this.drawTopSourcesSummaryBlock(page2, assets, mgTopY, repMeta);

    // 中间分割线：官方固定 Y = 501.0, 从 36.0 到 576.0
    const midLineY = 501.0;
    page2.drawLine({
      start: { x: LEFT_MARGIN, y: midLineY },
      end: { x: RIGHT_MARGIN, y: midLineY },
      thickness: 0.5,
      color: COLOR_LINE,
    });

    // Integrity Flags 区块：官方大标题 Y = 479.5
    const flagsTopY = 479.5;
    page2.drawText("Integrity Flags", {
      x: LEFT_MARGIN,
      y: flagsTopY,
      size: 10.0,
      font: assets.fontNotoSb,
      color: COLOR_HEADING,
    });

    // 官方子标题 Y = 465.5
    page2.drawText("0 Integrity Flags for Review", {
      x: LEFT_MARGIN,
      y: 465.5,
      size: 7.0,
      font: assets.fontNotoSb,
      color: COLOR_HEADING,
    });

    // 官方左侧小说明 Y = 450.5
    page2.drawText("No suspicious text manipulations found.", {
      x: LEFT_MARGIN,
      y: 450.5,
      size: 7.0,
      font: assets.fontNotoReg,
      color: COLOR_LABEL,
    });

    // 官方浅蓝说明框：x=309.0-8.0=301.0, y=473.5-64.0=409.5, w=266.0, h=64.0, r=8.0
    drawRoundedRect(page2, 301.0, 409.5, 266.0, 64.0, 8.0, {
      color: COLOR_FLAG_BOX,
    });

    const flagLines = [
      "Our system's algorithms look deeply at a document for any inconsistencies that",
      "would set it apart from a normal submission. If we notice something strange, we flag",
      "it for you to review.",
      "A Flag is not necessarily an indicator of a problem. However, we'd recommend you",
      "focus your attention there for further review.",
    ];
    // 官方真实基线：第一段起始 Y = 459.5 (3行，行距 8.0pt: 459.5, 451.5, 443.5)
    // 第二段起始 Y = 427.5 (2行，行距 8.0pt: 427.5, 419.5)
    const flagLineYs = [459.5, 451.5, 443.5, 427.5, 419.5];
    for (let idx = 0; idx < flagLines.length; idx++) {
      page2.drawText(flagLines[idx], {
        x: 313.0,
        y: flagLineYs[idx],
        size: 6.0,
        font: assets.fontNotoReg,
        color: COLOR_HEADING,
      });
    }

    this.drawFooter(page2, assets, 2, totalPages, "Integrity Overview", submissionID);

    // 3. 第 3 页及以后的 Top Sources 页面
    let curPageNum = 3;
    let pageSources = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.drawHeader(pageSources, assets, curPageNum, totalPages, "Integrity Overview", submissionID);

    // 官方 Page 3 Match Groups 与 Top Sources 概要顶线基准 Y = 728.0
    this.drawMatchGroupsBlock(pageSources, assets, 728.0, matchGroups);
    this.drawTopSourcesSummaryBlock(pageSources, assets, 728.0, repMeta);

    // 官方概览下分割线：固定 Y = 604.5, 从 36 到 576
    pageSources.drawLine({
      start: { x: LEFT_MARGIN, y: 604.5 },
      end: { x: RIGHT_MARGIN, y: 604.5 },
      thickness: 0.5,
      color: COLOR_LINE,
    });

    // 官方 "Top Sources" 大标题：Y = 575.5, 10pt SemiBold
    pageSources.drawText("Top Sources", {
      x: LEFT_MARGIN,
      y: 575.5,
      size: 10.0,
      font: assets.fontNotoSb,
      color: COLOR_HEADING,
    });

    // 官方小说明文字：Y = 560.5, 7pt Regular
    pageSources.drawText("The sources with the highest number of matches within the submission. Overlapping sources will not be displayed.", {
      x: LEFT_MARGIN,
      y: 560.5,
      size: 7.0,
      font: assets.fontNotoReg,
      color: COLOR_LABEL,
    });

    // 官方第 3 页首行胶囊 Y = 546.5，每行固定步进 48.0pt，最后一项胶囊位于 Y = 114.5
    let rowY = 546.5;
    const aggs = aggregates || [];

    for (let i = 0; i < aggs.length; i++) {
      if (rowY < 100.0) {
        // 翻页：第 4 页及后续页面，首行胶囊固定 Y = 717.0，每行步进 48.0pt
        this.drawFooter(pageSources, assets, curPageNum, totalPages, "Integrity Overview", submissionID);
        curPageNum++;
        pageSources = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        this.drawHeader(pageSources, assets, curPageNum, totalPages, "Integrity Overview", submissionID);
        rowY = 717.0;
      }

      this.drawTopSourceRow(pageSources, assets, aggs[i], rowY);
      rowY -= 48.0;
    }

    this.drawFooter(pageSources, assets, curPageNum, totalPages, "Integrity Overview", submissionID);
  }

  drawMatchGroupsBlock(page, assets, topY, matchGroups) {
    page.drawText("Match Groups", {
      x: LEFT_MARGIN,
      y: topY,
      size: 10.0,
      font: assets.fontNotoSb,
      color: COLOR_HEADING,
    });

    const mgSpecs = [
      {
        name: "Not Cited or Quoted",
        desc: "Matches with neither in-text citation nor quotation marks",
        bg: rgb(0.9727, 0.3867, 0.4414),
        iconW: 5.5,
        iconH: 6.0,
        iconDx: 3.0,
        iconDy: -1.0, // 在 textY(如 599.5) 下，iconY = 599.5 - 1.0 = 598.5
      },
      {
        name: "Missing Quotations",
        desc: "Matches that are still very similar to source material",
        bg: rgb(0.9648, 0.5586, 0.2891),
        iconW: 5.5,
        iconH: 3.5,
        iconDx: 3.5,
        iconDy: 0.0, // iconY = 574.5 + 0.0 = 574.5
      },
      {
        name: "Missing Citation",
        desc: "Matches that have quotation marks, but no in-text citation",
        bg: rgb(0.9570, 0.8945, 0.6680),
        iconW: 6.0,
        iconH: 4.0,
        iconDx: 3.0,
        iconDy: 0.0, // iconY = 549.5 + 0.0 = 549.5
      },
      {
        name: "Cited and Quoted",
        desc: "Matches with in-text citation present, but no quotation marks",
        bg: rgb(0.7578, 0.9258, 0.8750),
        iconW: 5.5,
        iconH: 6.0,
        iconDx: 3.0,
        iconDy: -1.0, // iconY = 524.5 - 1.0 = 523.5
      },
    ];

    // 官方真实基线：topY = 619.5 (Page 2) 时，textY 依次为 599.5, 574.5, 549.5, 524.5
    // topY = 728.0 (Page 3) 时，textY 依次为 708.0, 683.0, 658.0, 633.0
    // 官方底色圆圈 anchorX = 42.0, anchorY = textY + 8.0 (在 Page 2 依次为 607.5, 582.5, 557.5, 532.5; Page 3 依次为 716.0, 691.0, 666.0, 641.0)
    for (let i = 0; i < mgSpecs.length; i++) {
      const sp = mgSpecs[i];
      const textY = topY === 728.0 ? (708.0 - i * 25.0) : (599.5 - i * 25.0);

      // 绘制官方原生矢量圆圈
      drawOfficialMGCircle(page, 42.0, textY + 8.0, sp.bg);

      // 官方内嵌图标精准尺寸与绝对坐标
      if (assets.mgIcons[i]) {
        page.drawImage(assets.mgIcons[i], {
          x: 36.0 + sp.iconDx,
          y: textY + sp.iconDy,
          width: sp.iconW,
          height: sp.iconH,
        });
      }

      const countStr = String(matchGroups[i].count);
      const nameStr = sp.name;
      const percent = matchGroups[i].percent;
      const pctStr = percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;

      // 官方文字流基线 Y = textY
      // 数字 X=53.0 (SemiBold 7pt)
      page.drawText(countStr, {
        x: 53.0,
        y: textY,
        size: 7.0,
        font: assets.fontNotoSb,
        color: COLOR_HEADING,
      });

      page.drawText(`${nameStr}  ${pctStr}`, {
        x: 53.0 + assets.fontNotoSb.widthOfTextAtSize(countStr, 7.0) + 2.0,
        y: textY,
        size: 7.0,
        font: assets.fontNotoReg,
        color: COLOR_HEADING,
      });

      // 描述行基线：比标题行低 10.0pt (官方 589.5, 564.5, 539.5, 514.5 或 698, 673, 648, 623)
      page.drawText(sp.desc, {
        x: 53.0,
        y: textY - 10.0,
        size: 7.0,
        font: assets.fontNotoReg,
        color: COLOR_LABEL,
      });
    }
  }

  drawTopSourcesSummaryBlock(page, assets, topY, repMeta) {
    const rightColX = 298.5;
    const rightColLabelX = 336.0;

    page.drawText("Top Sources", {
      x: rightColX,
      y: topY,
      size: 10.0,
      font: assets.fontNotoSb,
      color: COLOR_HEADING,
    });

    // 官方右侧概要 3 行：基线依次为 599.5, 585.5, 571.5 (Page 2) 或 708, 694, 680 (Page 3)
    const items = [
      { pct: parseInt(repMeta && repMeta.internetMatchPercentage, 10) || 0, label: "Internet sources", img: assets.tsIcons.internet, imgX: 322.0, imgY: topY === 728.0 ? 706.0 : 597.5, w: 8.5, h: 8.5 },
      { pct: parseInt(repMeta && repMeta.publicationMatchPercentage, 10) || 0, label: "Publications", img: assets.tsIcons.publications, imgX: 322.0, imgY: topY === 728.0 ? 693.5 : 585.0, w: 9.0, h: 6.5 },
      { pct: parseInt(repMeta && repMeta.submittedWorksMatchPercentage, 10) || 0, label: "Submitted works (Student Papers)", img: assets.tsIcons.submitted, imgX: 323.0, imgY: topY === 728.0 ? 679.5 : 571.0, w: 6.5, h: 6.5 },
    ];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const y = topY === 728.0 ? (708.0 - i * 14.0) : (599.5 - i * 14.0);

      page.drawText(`${it.pct}%`, {
        x: rightColX,
        y: y,
        size: 7.0,
        font: assets.fontNotoReg,
        color: COLOR_HEADING,
      });

      if (it.img) {
        page.drawImage(it.img, {
          x: it.imgX,
          y: it.imgY,
          width: it.w,
          height: it.h,
        });
      }

      page.drawText(it.label, {
        x: rightColLabelX,
        y: y,
        size: 7.0,
        font: assets.fontNotoReg,
        color: COLOR_HEADING,
      });
    }
  }

  drawTopSourceRow(page, assets, agg, y) {
    const colors = getSourceColor(agg.index || agg.Index || 1);

    // 1. 官方序号胶囊：固定宽度 24.5pt, 高度 15.0pt, 半径 r = 7.0pt (官方在 y=546.5 下，y 范围 531.5 到 546.5)
    // 官方在 1 0 0 -1 0 0 下，y=546.5 cm，m 0 0 l 10.5 0 c 17.5 7 l 17.5 8 c 10.5 15 l 0 15 c -7 8 l -7 7 c 0 0
    // 左端 x = 43 - 7 = 36.0, 右端 x = 43 + 17.5 = 60.5, 宽 24.5pt
    // 下端 y = 546.5 - 15 = 531.5, 上端 y = 546.5
    // 数字基线固定在 textY = 536.5 (即 y - 10.0)
    const numH = 15.0;
    const numW = 24.5;
    const numX = LEFT_MARGIN;
    const numY = y - 15.0;
    drawPill(page, numX, numY, numW, numH, {
      color: colors.sat,
    });

    // 数字文本居中放置于胶囊正中间：X 从 36 到 60.5，中心点 48.25 (或官方单数字在 46.25，基线 y - 10.0)
    const digitStr = String(agg.index || agg.Index || 1);
    const digitW = assets.fontNotoSb.widthOfTextAtSize(digitStr, 7.0);
    page.drawText(digitStr, {
      x: numX + (numW - digitW) / 2,
      y: y - 10.0,
      size: 7.0,
      font: assets.fontNotoSb,
      color: rgb(1, 1, 1),
    });

    // 2. 官方类别胶囊：高度 15.0pt, 半径 r = 7.5pt (两端全半圆弧)
    let label = "Source";
    const col = agg.collection || agg.Collection || "";
    if (col.toUpperCase().includes("INTERNET")) label = "Internet";
    else if (col.toUpperCase().includes("PUBLICATION")) label = "Publication";
    else if (col.toUpperCase().includes("SUBMITTED")) label = "Student papers";
    else label = "Source";

    const labelW = assets.fontNotoSb.widthOfTextAtSize(label, 7.0);
    const typePillX = 66.0;
    const typePillH = 15.0;
    const typePillY = y - 15.0;
    let typePillW = 70.0;

    drawPill(page, typePillX, typePillY, typePillW, typePillH, {
      color: colors.pale,
    });

    // 官方类别文字起点：Publication 为 81.75，Internet 为 86.8，Source 居中或居左对齐
    let labelX = 86.8;
    if (label === "Publication") labelX = 81.75;
    else if (label === "Internet") labelX = 86.8;
    else if (label === "Source") labelX = 88.0;
    else labelX = 66.0 + (typePillW - labelW) / 2;

    page.drawText(label, {
      x: labelX,
      y: y - 10.0,
      size: 7.0,
      font: assets.fontNotoSb,
      color: COLOR_HEADING,
    });

    // 3. 官方来源标题与百分比：基线固定在 textY = y - 28.0 (例如 518.5)
    const titleY = y - 28.0;
    let title = agg.linkText || agg.LinkText || "Source Document";
    const dateSuffix = label === "Student papers" && agg.submittedDate
      ? ` on ${agg.submittedDate}` : "";
    if (dateSuffix && !title.endsWith(dateSuffix)) {
      title += dateSuffix;
    }
    if (label === "Student papers" && assets.fontNotoSb.widthOfTextAtSize(title, 8.0) > 340.0) {
      const name = Array.from(dateSuffix && title.endsWith(dateSuffix) ? title.slice(0, -dateSuffix.length) : title);
      while (name.length > 0 && assets.fontNotoSb.widthOfTextAtSize(name.join("") + "…" + dateSuffix, 8.0) > 340.0) {
        name.pop();
      }
      title = name.join("") + "…" + dateSuffix;
    } else if (label !== "Student papers" && title.length > 75) {
      title = title.substring(0, 75) + " …";
    }

    const titleW = assets.fontNotoSb.widthOfTextAtSize(title, 8.0);
    page.drawText(title, {
      x: LEFT_MARGIN,
      y: titleY,
      size: 8.0,
      font: assets.fontNotoSb,
      color: COLOR_HEADING,
    });

    // 若为 Internet 类型且包含链接，在 PDF 中注入真实可交互点击的超链接 Annotation
    const linkUrl = agg.link || agg.Link || (label === "Internet" && title.startsWith("http") ? title : (label === "Internet" ? `https://${title}` : ""));
    if (label === "Internet" && linkUrl) {
      const linkAnnot = page.doc.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [LEFT_MARGIN, titleY - 2.0, LEFT_MARGIN + Math.min(titleW, 340.0), titleY + 10.0],
        Border: [0, 0, 0],
        A: {
          Type: "Action",
          S: "URI",
          URI: PDFString.of(linkUrl),
        },
      });
      const linkRef = page.doc.context.register(linkAnnot);
      let existingAnnots = page.node.lookup(PDFName.of("Annots"));
      if (!existingAnnots) {
        existingAnnots = page.doc.context.obj([]);
        page.node.set(PDFName.of("Annots"), existingAnnots);
      }
      existingAnnots.push(linkRef);
    }

    // 百分比数值 (固定在 x=386.0 处)
    const rawPct = agg.percent !== undefined ? agg.percent : (agg.Percent !== undefined ? agg.Percent : 0);
    const pct = typeof rawPct === "number" ? rawPct : parseFloat(rawPct) || 0;
    const pctStr = pct < 1.0 ? "<1%" : `${Math.round(pct)}%`;
    page.drawText(pctStr, {
      x: 386.0,
      y: titleY,
      size: 8.0,
      font: assets.fontNotoSb,
      color: COLOR_HEADING,
    });

    // 4. 官方底部分割线：固定 Y = y - 38.0 (例如 508.5)，从 36.0 到 400.0 (长度 364pt)
    page.drawLine({
      start: { x: LEFT_MARGIN, y: y - 38.0 },
      end: { x: 400.0, y: y - 38.0 },
      thickness: 0.5,
      color: COLOR_LINE,
    });
  }
}

module.exports = {
  TIISimilarityCoverRenderer,
  summarizeMatchGroups,
};
