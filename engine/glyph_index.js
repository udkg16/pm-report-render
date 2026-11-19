/**
 * 纯 JS 字符坐标索引与正文高亮计算 (OffsetIndex)
 * 100% 对齐 Turnitin 官方 ClientCore.GlyphLine 与 MarkCore.HighlightLineShape
 */

function buildOffsetIndex(glyphData) {
  const glyphMap = {};
  const pageIndices = [];
  const pages = glyphData.pages || [];
  const rawGlyphData = glyphData.glyph_data || [];

  if (pages.length > 0) {
    for (let i = 0; i < pages.length; i++) {
      pageIndices.push(pages[i] - 1);
    }
  } else {
    for (let i = 0; i < rawGlyphData.length; i++) {
      pageIndices.push(i);
    }
  }

  for (let i = 0; i < rawGlyphData.length; i++) {
    if (i >= pageIndices.length) break;
    const pageIdx = pageIndices[i];
    const runsArr = rawGlyphData[i];
    if (!Array.isArray(runsArr)) continue;

    const runList = [];
    for (const rawRun of runsArr) {
      if (!Array.isArray(rawRun) || rawRun.length < 3) continue;
      const metaArr = rawRun[0];
      const boxesArr = rawRun[1];
      const charsArr = rawRun[2];
      if (!Array.isArray(metaArr) || !Array.isArray(boxesArr) || !Array.isArray(charsArr) || metaArr.length < 3) {
        continue;
      }

      const y = Math.round(metaArr[0]);
      const fontSize = Math.round(metaArr[1]);
      const descent = Math.round(metaArr[2]);
      const flag = metaArr.length > 3 ? Math.round(metaArr[3]) : 0;
      const ascent = fontSize;

      const runGlyphs = [];
      for (let gIdx = 0; gIdx < charsArr.length; gIdx++) {
        if (gIdx >= boxesArr.length) break;
        const box = boxesArr[gIdx];
        if (!Array.isArray(box) || box.length < 2) continue;
        const gx = Math.round(box[0]);
        const gw = Math.round(box[1]);
        const gflag = box.length > 2 ? Math.round(box[2]) : 0;
        // 7 项数据: gx, gw, gflag, y, ascent, descent, flag
        runGlyphs.push([gx, gw, gflag, y, ascent, descent, flag]);
      }
      if (runGlyphs.length > 0) {
        runList.push(runGlyphs);
      }
    }
    glyphMap[pageIdx] = runList;
  }

  const byteOffsetInfo = {};
  let targetMap = glyphData.byte_offset_info || {};
  if (targetMap.glyph_index_map) {
    targetMap = targetMap.glyph_index_map;
  }
  for (const [k, v] of Object.entries(targetMap)) {
    const byteOff = parseInt(k, 10);
    if (Array.isArray(v) && v.length >= 3) {
      byteOffsetInfo[byteOff] = [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])];
    }
  }

  const pageByteStarts = {};
  for (const [bOffStr, addr] of Object.entries(byteOffsetInfo)) {
    const bOff = parseInt(bOffStr, 10);
    const p = addr[0];
    if (pageByteStarts[p] === undefined || bOff < pageByteStarts[p]) {
      pageByteStarts[p] = bOff;
    }
  }

  return {
    glyphMap,
    byteOffsetInfo,
    pageByteStarts,

    segmentsToRects(segments, scaleForPage) {
      const out = [];
      for (const seg of segments) {
        if (!Array.isArray(seg) || seg.length < 2) continue;
        const rects = this.zy(scaleForPage, seg[0], seg[1]);
        out.push(...rects);
      }
      return out;
    },

    zy(scaleForPage, startByte, endByte) {
      const pages = Object.keys(this.pageByteStarts).map(Number).sort((a, b) => a - b);
      if (pages.length === 0) return [];

      const tr = (byteOff) => {
        for (let i = 0; i < pages.length; i++) {
          const start = this.pageByteStarts[pages[i]];
          const end = i + 1 < pages.length ? this.pageByteStarts[pages[i + 1]] : Infinity;
          if (byteOff >= start && byteOff < end) return pages[i];
        }
        return -1;
      };

      const p0 = tr(startByte);
      const p1 = tr(endByte);
      if (p0 === -1 || p1 === -1) return [];

      let start = this.byteOffsetInfo[startByte];
      let end = this.byteOffsetInfo[endByte];
      if (!start) return [];
      if (!end) {
        for (let cand = endByte; cand >= startByte; cand--) {
          if (this.byteOffsetInfo[cand]) {
            end = this.byteOffsetInfo[cand];
            break;
          }
        }
        if (!end) return [];
      }

      const results = [];
      for (let page = start[0]; page <= end[0]; page++) {
        const pageLines = this.glyphMap[page];
        if (!pageLines) continue;

        const scale = scaleForPage(page);
        const isStartPage = page === start[0];
        const isEndPage = page === end[0];

        let lineStart = isStartPage ? start[1] : 0;
        let lineEnd = isEndPage ? end[1] : pageLines.length - 1;
        if (lineStart >= pageLines.length) lineStart = 0;
        if (lineEnd >= pageLines.length) lineEnd = pageLines.length - 1;

        for (let lIdx = lineStart; lIdx <= lineEnd; lIdx++) {
          const line = pageLines[lIdx];
          const fromGlyph = isStartPage && lIdx === start[1] ? start[2] : 0;
          const toGlyph = isEndPage && lIdx === end[1] ? end[2] : line.length - 1;

          const r = this.hz(line, fromGlyph, toGlyph);
          if (r.w > 0 && r.h > 0) {
            results.push({
              page: page,
              x0: r.left * scale,
              y0: r.top * scale,
              x1: (r.left + r.w) * scale,
              y1: (r.top + r.h) * scale,
            });
          }
          if (isEndPage && lIdx >= end[1]) break;
        }
      }
      return results;
    },

    hz(line, fromG, toG) {
      if (fromG < 0 || toG < 0 || fromG >= line.length || toG >= line.length || fromG > toG) {
        return { top: 0, height: 0, left: 0, w: 0, h: 0 };
      }
      const g = line[fromG];
      const y = g[3];
      const ascent = g[4];
      const descent = g[5];
      const flag = g[6];

      const top = y - ascent;
      const height = ascent + descent;
      const left = g[0];
      const lastG = line[toG];
      const right = lastG[0] + lastG[1];

      if ((flag & 1) !== 0) {
        return { top, height, h: height, left: lastG[0], w: g[0] + g[1] - lastG[0] };
      }
      return { top, height, h: height, left, w: right - left };
    },
  };
}

module.exports = {
  buildOffsetIndex,
};
