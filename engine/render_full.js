const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const { TIICoverRenderer } = require("./cover.js");
const { TIIAICoverRenderer } = require("./ai_cover.js");
const { TIISimilarityCoverRenderer, summarizeMatchGroups } = require("./similarity_cover.js");
const { buildOffsetIndex } = require("./glyph_index.js");
const { drawPageHighlights } = require("./highlight_drawer.js");

function toFloat(v) {
  if (v === undefined || v === null) return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function collectSimilarityData(index, ovtData, scaleForPage) {
  const overlays = [];
  const aggregates = [];

  const tv = ovtData && ovtData.taggedView;
  if (!tv) return { overlays, aggregates };

  let sourceIdx = 1;
  for (const tagData of Object.values(tv)) {
    if (!tagData) continue;
    const matchAggs = tagData.matchAggregates || [];
    for (const agg of matchAggs) {
      if (!agg) continue;
      const linkText = agg.linkText || "";
      const pct = toFloat(agg.percent);
      const col = agg.collection || "";
      let link = agg.link || "";

      const sources = agg.matchSources || [];
      if (!link && sources.length > 0 && sources[0]) {
        link = sources[0].link || "";
      }

      const submittedDates = sources.map(source => source?.submittedDate);
      const submittedDate = submittedDates.length > 0 &&
        submittedDates.every(date => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && date === submittedDates[0])
        ? submittedDates[0] : null;
      aggregates.push({
        index: sourceIdx,
        linkText: linkText,
        percent: pct,
        collection: col,
        link: link,
        submittedDate,
      });

      const seen = new Set();
      for (const src of sources) {
        if (!src) continue;
        const groups = src.matchGroups || [];
        for (const grp of groups) {
          if (!grp) continue;
          const segs = grp.matchSegments || [];
          const validSegs = [];
          for (const seg of segs) {
            if (!Array.isArray(seg) || seg.length < 2) continue;
            const s0 = Math.round(toFloat(seg[0]));
            const s1 = Math.round(toFloat(seg[1]));
            const key = `${s0}_${s1}`;
            if (!seen.has(key)) {
              seen.add(key);
              validSegs.push([s0, s1]);
            }
          }
          const rects = index.segmentsToRects(validSegs, scaleForPage);
          for (const r of rects) {
            overlays.push({
              page: r.page,
              x0: r.x0,
              y0: r.y0,
              x1: r.x1,
              y1: r.y1,
              sourceIndex: sourceIdx,
            });
          }
        }
      }
      sourceIdx++;
    }
  }

  return { overlays, aggregates };
}

function collectAIData(index, aiRepData, scaleForPage) {
  const overlays = [];
  const sentences = (aiRepData && aiRepData.sentences) || [];
  for (const s of sentences) {
    if (!s) continue;
    const labels = s.labels || [];
    const hasAI = labels.includes("aiw");
    if (!hasAI) continue;

    const textSegs = s.textSegments || [];
    const validSegs = [];
    for (const seg of textSegs) {
      if (!Array.isArray(seg) || seg.length < 2) continue;
      validSegs.push([Math.round(toFloat(seg[0])), Math.round(toFloat(seg[1]))]);
    }
    const rects = index.segmentsToRects(validSegs, scaleForPage);
    for (const r of rects) {
      overlays.push({
        page: r.page,
        x0: r.x0,
        y0: r.y0,
        x1: r.x1,
        y1: r.y1,
      });
    }
  }
  return overlays;
}

class FullPureJSRenderer {
  constructor(resDir) {
    this.resDir = resDir || path.join(__dirname, "res");
    this.coverRenderer = new TIICoverRenderer(this.resDir);
    this.aiCoverRenderer = new TIIAICoverRenderer(this.resDir);
    this.simCoverRenderer = new TIISimilarityCoverRenderer(this.resDir);
  }

  async render(type, materials, metadata) {
    const { glyphData, subData, reportData, overviewData, blankBytes } = materials;
    const subMeta = { ...(subData.metadata || subData) };
    if (metadata.document_name?.trim()) subMeta.filename = metadata.document_name;
    if (metadata.author_name?.trim()) subMeta.cover_author = metadata.author_name;
    subMeta.cover_name_seed = metadata.cover_name_seed;
    const repMeta = { ...(reportData.metadata || reportData), overallMatchPercentage: metadata.score_percent };
    const ratio = metadata.score_percent / 100;
    const aiMeta = { ...reportData.resultSummary, rollupPercent: ratio };
    const submissionID = subMeta.submission_trn || subMeta.submissionTrn || metadata.submission_id;

    // 1. 构建 OffsetIndex
    const index = buildOffsetIndex(glyphData);

    // 2. 加载 blank.pdf 获取正文页数与每页尺寸
    const testDoc = await PDFDocument.load(blankBytes);
    const bodyPageCount = testDoc.getPageCount();
    if (bodyPageCount < 1) throw new Error("empty source PDF");

    const imageDimensions = subMeta.image_dimensions || [];
    const scaleForPage = (p) => {
      if (p >= 0 && p < imageDimensions.length && imageDimensions[p]) {
        const imgW = toFloat(imageDimensions[p].width);
        if (imgW > 0 && p < bodyPageCount) {
          const pageW = testDoc.getPage(p).getWidth();
          return pageW / imgW;
        }
      }
      return 72.0 / 130.0;
    };

    // ==========================================
    // 3. 纯 JS 渲染 相似度报告 (Similarity Report)
    // ==========================================
    if (type === "similarity") {
    const { overlays: simOverlays, aggregates } = collectSimilarityData(index, overviewData, scaleForPage);

    let sourcePages = 1;
    if (aggregates.length > 10) {
      sourcePages = 1 + Math.floor((aggregates.length - 10 + 13) / 14);
    }
    const simCoverPageCount = 2 + sourcePages;
    const totalSimPages = simCoverPageCount + bodyPageCount;

    // 3.1 生成 Similarity 封面
    const simCoverDoc = await PDFDocument.create();
    simCoverDoc.setProducer("pdf-lib (https://github.com/Hopding/pdf-lib)");
    simCoverDoc.setCreator("pdf-lib (https://github.com/Hopding/pdf-lib)");
    await this.simCoverRenderer.renderSimilarityCoverPages(
      simCoverDoc,
      subMeta,
      repMeta,
      aggregates,
      submissionID,
      totalSimPages,
      summarizeMatchGroups(overviewData.taggedView)
    );

    // 3.2 加载正文并绘制高亮 + Header/Footer + Margin 胶囊
    const simBodyDoc = await PDFDocument.load(blankBytes);
    const simAssets = await this.simCoverRenderer.loadSimAssets(simBodyDoc);
    simAssets.coverRenderer = this.coverRenderer;

    const simPageOverlays = {};
    for (const ov of simOverlays) {
      if (!simPageOverlays[ov.page]) simPageOverlays[ov.page] = [];
      simPageOverlays[ov.page].push(ov);
    }

    for (let p = 0; p < bodyPageCount; p++) {
      const page = simBodyDoc.getPage(p);
      const curPageNum = simCoverPageCount + 1 + p;
      const boxes = simPageOverlays[p] || [];
      drawPageHighlights(page, boxes, false, curPageNum, totalSimPages, "Integrity Submission", submissionID, simAssets);
    }

    // 3.3 拼合封面与正文
    const finalSimDoc = await PDFDocument.create();
    finalSimDoc.setProducer("pdf-lib (https://github.com/Hopding/pdf-lib)");
    finalSimDoc.setCreator("pdf-lib (https://github.com/Hopding/pdf-lib)");

    const copiedCoverPages = await finalSimDoc.copyPages(simCoverDoc, simCoverDoc.getPageIndices());
    for (const page of copiedCoverPages) {
      finalSimDoc.addPage(page);
    }
    const copiedBodyPages = await finalSimDoc.copyPages(simBodyDoc, simBodyDoc.getPageIndices());
    for (const page of copiedBodyPages) {
      finalSimDoc.addPage(page);
    }

    return finalSimDoc.save();
    }

    // ==========================================
    // 4. 纯 JS 渲染 AI 报告 (AI Writing Report)
    // ==========================================
    let aiSegments = [];
    if (metadata.score_percent >= 20) {
      aiSegments = collectAIData(index, reportData, scaleForPage);
    }

    const totalAIPages = 2 + bodyPageCount;

    // 4.1 生成 AI 封面
    const aiCoverDoc = await PDFDocument.create();
    aiCoverDoc.setProducer("pdf-lib (https://github.com/Hopding/pdf-lib)");
    aiCoverDoc.setCreator("pdf-lib (https://github.com/Hopding/pdf-lib)");
    await this.aiCoverRenderer.renderAICoverPages(aiCoverDoc, subMeta, aiMeta, submissionID, totalAIPages);

    // 4.2 加载正文并绘制 AI 高亮 + Header/Footer
    const aiBodyDoc = await PDFDocument.load(blankBytes);
    const aiAssets = await this.aiCoverRenderer.loadAIAssets(aiBodyDoc);
    aiAssets.coverRenderer = this.coverRenderer;

    const aiPageSegments = {};
    for (const seg of aiSegments) {
      if (!aiPageSegments[seg.page]) aiPageSegments[seg.page] = [];
      aiPageSegments[seg.page].push(seg);
    }

    for (let p = 0; p < bodyPageCount; p++) {
      const page = aiBodyDoc.getPage(p);
      const curPageNum = 3 + p; // AI 封面固定 2 页，正文从第 3 页起
      const boxes = aiPageSegments[p] || [];
      drawPageHighlights(page, boxes, true, curPageNum, totalAIPages, "AI Writing Submission", submissionID, aiAssets);
    }

    // 4.3 拼合 AI 封面与正文
    const finalAIDoc = await PDFDocument.create();
    finalAIDoc.setProducer("pdf-lib (https://github.com/Hopding/pdf-lib)");
    finalAIDoc.setCreator("pdf-lib (https://github.com/Hopding/pdf-lib)");

    const copiedAICoverPages = await finalAIDoc.copyPages(aiCoverDoc, aiCoverDoc.getPageIndices());
    for (const page of copiedAICoverPages) {
      finalAIDoc.addPage(page);
    }
    const copiedAIBodyPages = await finalAIDoc.copyPages(aiBodyDoc, aiBodyDoc.getPageIndices());
    for (const page of copiedAIBodyPages) {
      finalAIDoc.addPage(page);
    }

    return finalAIDoc.save();
  }
}

module.exports = {
  FullPureJSRenderer,
  collectSimilarityData,
};
