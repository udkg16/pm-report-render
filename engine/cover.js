const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { PDFDocument, rgb, degrees } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");

const PAGE_WIDTH = 612.0;
const PAGE_HEIGHT = 792.0;
const LEFT_MARGIN = 36.0;
const RIGHT_MARGIN = 576.0;
const MAX_TITLE_WIDTH = PAGE_WIDTH / 2;
const cjkFontDir = path.dirname(require.resolve("@expo-google-fonts/noto-sans-sc/package.json"));

// 官方标准色彩定义
const COLOR_HEADING = rgb(25 / 255, 25 / 255, 25 / 255); // #191919
const COLOR_LABEL = rgb(99 / 255, 99 / 255, 99 / 255);   // #636363
const COLOR_LINE = rgb(204 / 255, 204 / 255, 204 / 255);  // #CCCCCC (0.80)
const COLOR_BOX_BG = rgb(248 / 255, 248 / 255, 248 / 255); // #F8F8F8

function formatDT(v, tzStr = "GMT+8") {
  if (!v) return "—";
  let s = String(v).trim();
  let d;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
    if (!s.endsWith("Z") && !/[+-]\d{2}:?\d{2}$/.test(s)) {
      s += "Z";
    }
    d = new Date(s);
  } else {
    d = new Date(s);
  }

  if (isNaN(d.getTime())) return String(v);

  let tzOffsetMinutes = 8 * 60; // 默认 GMT+8
  if (typeof tzStr === "string") {
    let m = tzStr.match(/GMT([+-]\d+)/i);
    if (m) {
      tzOffsetMinutes = parseInt(m[1], 10) * 60;
    }
  }

  const targetDate = new Date(d.getTime() + tzOffsetMinutes * 60 * 1000);
  const year = targetDate.getUTCFullYear();
  const monthIdx = targetDate.getUTCMonth();
  const day = targetDate.getUTCDate();
  let hour = targetDate.getUTCHours();
  const minute = targetDate.getUTCMinutes();

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const ampm = hour >= 12 ? "PM" : "AM";
  if (hour > 12) hour -= 12;
  if (hour === 0) hour = 12;

  const padMin = String(minute).padStart(2, "0");
  const tzSuffix = tzStr ? ` ${tzStr}` : "";
  return `${months[monthIdx]} ${day}, ${year}, ${hour}:${padMin} ${ampm}${tzSuffix}`;
}

function formatSize(v) {
  if (v === undefined || v === null || v === "") return "—";
  const n = Number(v);
  if (isNaN(n)) return "—";
  if (n >= 1024 * 1024) {
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }
  if (n >= 1024) {
    return (n / 1024).toFixed(1) + " KB";
  }
  return n.toFixed(0) + " B";
}

function formatNumber(n) {
  if (n === undefined || n === null || isNaN(Number(n))) return "0";
  return Number(n).toLocaleString("en-US");
}

function formatSubmissionID(subID) {
  if (!subID) return "—";
  let s = String(subID);
  if (s.startsWith("trn:")) return s;
  s = s.replace(/^oid:/, "");
  return "trn:oid:::" + s;
}

// 自动文本折行算法
function wrapText(text, font, fontSize, maxWidth) {
  const lines = [];
  let currentLine = "";
  for (const word of text.split(" ")) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      currentLine = candidate;
      continue;
    }
    if (currentLine) lines.push(currentLine);
    currentLine = "";
    for (const char of word) {
      if (currentLine && font.widthOfTextAtSize(currentLine + char, fontSize) > maxWidth) {
        lines.push(currentLine);
        currentLine = "";
      }
      currentLine += char;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

function textRuns(text, preferred, fallback) {
  const characters = new Set(preferred.getCharacterSet());
  const runs = [];
  for (const char of text) {
    const font = characters.has(char.codePointAt(0)) ? preferred : fallback;
    const last = runs[runs.length - 1];
    if (last && last.font === font) last.text += char;
    else runs.push({text: char, font});
  }
  return runs;
}

function runsWidth(runs, size) {
  return runs.reduce((width, run) => width + run.font.widthOfTextAtSize(run.text, size), 0);
}

function coverNames(filename, submissionID, font) {
  const ext = path.extname(filename);
  const title = ext ? filename.slice(0, -ext.length) : filename;
  if (font.widthOfTextAtSize(title, 17.0) <= MAX_TITLE_WIDTH) {
    return { title, filename };
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const hash = createHash("sha256").update(JSON.stringify([submissionID, filename])).digest();
  let value = hash.readBigUInt64BE(0);
  let replacement = "";
  for (let i = 0; i < 6; i++) {
    replacement += alphabet[Number(value % 52n)];
    value /= 52n;
  }
  return { title: replacement, filename: replacement + ext };
}

class TIICoverRenderer {
  constructor(resDir) {
    this.resDir = resDir || path.join(__dirname, "res");
  }

  async loadAssets(doc) {
    doc.registerFontkit(fontkit);

    const notoRegBytes = fs.readFileSync(path.join(this.resDir, "subset-NotoSans-Regular.ttf"));
    const notoSbBytes = fs.readFileSync(path.join(this.resDir, "subset-NotoSans-SemiBold.ttf"));
    const lexendBytes = fs.readFileSync(path.join(this.resDir, "subset-LexendDeca-Medium.ttf"));
    const lexendSbBytes = fs.readFileSync(path.join(this.resDir, "LexendDeca-SemiBold.ttf"));

    const fontNotoReg = await doc.embedFont(notoRegBytes);
    const fontNotoSb = await doc.embedFont(notoSbBytes);
    const fontLexend = await doc.embedFont(lexendBytes);
    const fontLexendSb = await doc.embedFont(lexendSbBytes);

    let logoImg = null;
    const logoPath = path.join(this.resDir, "turnitin_logo.png");
    if (fs.existsSync(logoPath)) {
      logoImg = await doc.embedPng(fs.readFileSync(logoPath));
    }

    let docIconImg = null;
    const docIconPath = path.join(this.resDir, "document_icon.png");
    if (fs.existsSync(docIconPath)) {
      docIconImg = await doc.embedPng(fs.readFileSync(docIconPath));
    }

    return {
      fontNotoReg,
      fontNotoSb,
      fontLexend,
      fontLexendSb,
      logoImg,
      docIconImg,
    };
  }

  async documentNameFont(doc, text, preferred, assets, weight = "regular") {
    const characters = new Set(preferred.getCharacterSet());
    if (Array.from(text).every(char => characters.has(char.codePointAt(0)))) return preferred;
    const key = {regular: "fontCJK", medium: "fontCJKMedium", semibold: "fontCJKSemibold"}[weight];
    if (!key) throw new Error("Unsupported CJK font weight");
    if (!assets[key]) {
      const style = {regular: "Regular", medium: "Medium", semibold: "SemiBold"}[weight];
      const bundled = {regular: "400Regular", medium: "500Medium", semibold: "600SemiBold"}[weight];
      const candidates = [
        path.join(this.resDir, `NotoSansCJKsc-${style}.otf`),
        path.join(this.resDir, `NotoSansSC-${style}.ttf`),
        path.join(cjkFontDir, bundled, `NotoSansSC_${bundled}.ttf`),
      ];
      const fontPath = candidates.find(file => fs.existsSync(file));
      if (!fontPath) throw new Error("Chinese cover rendering requires a CJK font in the assets directory");
      assets[key] = await doc.embedFont(fs.readFileSync(fontPath));
    }
    const fallbackCharacters = new Set(assets[key].getCharacterSet());
    if (!Array.from(text).every(char => fallbackCharacters.has(char.codePointAt(0)))) {
      throw new Error("The CJK font does not cover all document name characters");
    }
    return assets[key];
  }

  drawHeader(page, assets, pageNum, totalPages, section, submissionID) {
    // 官方头部排版：y 从底部算起
    // 官网 header: Logo at (36, 751.5), w=55, h=16.5; 文本基线 y=758, 字体 6pt
    if (assets.logoImg) {
      page.drawImage(assets.logoImg, {
        x: LEFT_MARGIN,
        y: 751.5,
        width: 55.0,
        height: 16.5,
      });
    }

    const headerText = `Page ${pageNum} of ${totalPages} - ${section}`;
    page.drawText(headerText, {
      x: 107.0,
      y: 758.0,
      size: 6.0,
      font: assets.fontNotoReg,
      color: COLOR_HEADING,
    });

    page.drawText("Submission ID", {
      x: 460.67,
      y: 758.0,
      size: 6.0,
      font: assets.fontNotoReg,
      color: COLOR_HEADING,
    });

    const subIDText = formatSubmissionID(submissionID);
    page.drawText(subIDText, {
      x: 506.12,
      y: 758.0,
      size: 6.0,
      font: assets.fontNotoReg,
      color: COLOR_HEADING,
    });
  }

  drawFooter(page, assets, pageNum, totalPages, section, submissionID) {
    // 官方底部排版：Logo at (36, 27.5), w=55, h=16.5; 文本基线 y=34, 字体 6pt
    if (assets.logoImg) {
      page.drawImage(assets.logoImg, {
        x: LEFT_MARGIN,
        y: 27.5,
        width: 55.0,
        height: 16.5,
      });
    }

    const footerText = `Page ${pageNum} of ${totalPages} - ${section}`;
    page.drawText(footerText, {
      x: 107.0,
      y: 34.0,
      size: 6.0,
      font: assets.fontNotoReg,
      color: COLOR_HEADING,
    });

    page.drawText("Submission ID", {
      x: 460.67,
      y: 34.0,
      size: 6.0,
      font: assets.fontNotoReg,
      color: COLOR_HEADING,
    });

    const subIDText = formatSubmissionID(submissionID);
    page.drawText(subIDText, {
      x: 506.12,
      y: 34.0,
      size: 6.0,
      font: assets.fontNotoReg,
      color: COLOR_HEADING,
    });
  }

  /**
   * 绘制第 1 页 Cover Page (高保真还原官网像素、字重与布局)
   */
  async renderCoverPage(doc, subMeta, submissionID, totalPages) {
    const assets = await this.loadAssets(doc);
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

    // 1. 顶部 Header
    this.drawHeader(page, assets, 1, totalPages, "Cover Page", submissionID);

    // 2. 提取文件名与标题（优先使用真实文件名，若为 unknown_filename 则回退）
    let rawFilename = (subMeta && (subMeta.filename || subMeta.file_name || subMeta.title || subMeta.name)) || "";
    if (!rawFilename || rawFilename === "unknown_filename" || rawFilename === "unknown") {
      rawFilename = (subMeta && (subMeta.document_name || subMeta.original_filename || subMeta.title)) || "Document";
    }
    const originalFilename = String(rawFilename).replace(/[\u0000-\u001f\u007f]/g, " ").trim() || "Document";
    const ext = path.extname(originalFilename);
    const originalTitle = ext ? originalFilename.slice(0, -ext.length) : originalFilename;
    const titleFallback = await this.documentNameFont(doc, originalTitle, assets.fontLexendSb, assets, "medium");
    const originalRuns = textRuns(originalTitle, assets.fontLexendSb, titleFallback);
    const measuredTitle = {
      widthOfTextAtSize: (_, size) => runsWidth(originalRuns, size),
    };
    const {title: titleDisplay, filename} = coverNames(originalFilename, subMeta?.cover_name_seed || submissionID, measuredTitle);
    const author = String(subMeta?.cover_author || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();

    // 3. Document 状态胶囊 / 小图标区域 (y=383, 文本 y=386)
    if (assets.docIconImg) {
      page.drawImage(assets.docIconImg, {
        x: LEFT_MARGIN,
        y: 383.0,
        width: 12.0,
        height: 12.0,
      });
    }
    // 状态类别标签（如 "Document Details" 前导或论文小标题类别）
    page.drawText("Document", {
      x: LEFT_MARGIN + 20.0,
      y: 386.0,
      size: 8.0,
      font: assets.fontNotoReg,
      color: COLOR_LABEL,
    });

    // 4. 论文大标题 (折行处理，从 y=428 向上排版或在 428 开始)
    // 官网单行或多行折行规则
    const maxTitleWidth = RIGHT_MARGIN - LEFT_MARGIN;
    const titleRuns = titleDisplay === originalTitle ? originalRuns : [{text: titleDisplay, font: assets.fontLexendSb}];
    const curTitleY = author ? 406.0 : 428.0;
    let titleX = LEFT_MARGIN;
    for (const run of titleRuns) {
      page.drawText(run.text, {
        x: titleX,
        y: curTitleY,
        size: 17.0,
        font: run.font,
        color: COLOR_HEADING,
      });
      titleX += run.font.widthOfTextAtSize(run.text, 17.0);
    }
    if (author) {
      const authorFont = await this.documentNameFont(doc, author, assets.fontLexendSb, assets, "medium");
      const authorLines = wrapText(author, authorFont, 20.0, maxTitleWidth).slice(0, 3);
      const authorY = curTitleY + 30.0 + (authorLines.length - 1) * 26.0;
      for (let i = 0; i < authorLines.length; i++) {
        page.drawText(authorLines[i], {
          x: LEFT_MARGIN, y: authorY - i * 26.0, size: 20.0,
          font: authorFont, color: COLOR_HEADING,
        });
      }
    }

    // 5. 分割横线 y=367 (x=36 to 576, 宽度 0.5pt, 颜色 #CCCCCC)
    page.drawLine({
      start: { x: LEFT_MARGIN, y: 367.0 },
      end: { x: RIGHT_MARGIN, y: 367.0 },
      thickness: 0.5,
      color: COLOR_LINE,
    });

    // 6. "Document Details" 小标题 (y=338, 10pt SemiBold, #191919)
    page.drawText("Document Details", {
      x: LEFT_MARGIN,
      y: 338.0,
      size: 10.0,
      font: assets.fontNotoSb,
      color: COLOR_HEADING,
    });

    // 7. 左侧详情元数据 5 组 (Label 7pt #636363, Value 7pt #191919)
    // 严格按照官方原生坐标：
    // Item 1: y=312 (Label), y=298 (Value) - Submission ID
    // Item 2: y=276 (Label), y=262 (Value) - Submission Date
    // Item 3: y=240 (Label), y=226 (Value) - Download Date
    // Item 4: y=204 (Label), y=190 (Value) - File Name
    // Item 5: y=168 (Label), y=154 (Value) - File Size
    // 计算 Submission Date 与 Download Date（按 +8 时间，出结果时间/下载时间在提交后 3 分钟）
    let baseTime = (subMeta && (subMeta.ingest_request_time || subMeta.ingest_complete_time || subMeta.created_at)) || new Date().toISOString();
    let rawSub = String(baseTime).trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(rawSub)) {
      if (!rawSub.endsWith("Z") && !/[+-]\d{2}:?\d{2}$/.test(rawSub)) {
        rawSub += "Z";
      }
    }
    const dSub = new Date(rawSub);
    const validDSub = isNaN(dSub.getTime()) ? new Date() : dSub;
    const dDown = new Date(validDSub.getTime() + 10 * 1000); // 出结果/下载时间在生成时间 10 秒后

    let subDateStr = formatDT(validDSub, "GMT+8");
    let downDateStr = formatDT(dDown, "GMT+8");

    const rows = [
      { label: "Submission ID", val: formatSubmissionID(submissionID) },
      { label: "Submission Date", val: subDateStr },
      { label: "Download Date", val: downDateStr },
      { label: "File Name", val: filename },
      { label: "File Size", val: formatSize(subMeta && subMeta.filesize) },
    ];

    const labelYs = [312.0, 276.0, 240.0, 204.0, 168.0];
    const valYs =   [298.0, 262.0, 226.0, 190.0, 154.0];

    const maxValWidth = 350.0; // 避免与右侧侧边栏重叠
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      page.drawText(r.label, {
        x: LEFT_MARGIN,
        y: labelYs[i],
        size: 7.0,
        font: assets.fontNotoSb,
        color: COLOR_LABEL,
      });

      // 对过长的文件名做单行省略裁剪
      const valueFont = r.label === "File Name"
        ? await this.documentNameFont(doc, r.val, assets.fontNotoSb, assets, "semibold")
        : assets.fontNotoSb;
      let displayVal = r.val;
      let valueRuns = textRuns(displayVal, assets.fontNotoSb, valueFont);
      if (runsWidth(valueRuns, 7.0) > maxValWidth) {
        const chars = Array.from(displayVal);
        while (chars.length > 3 && runsWidth(textRuns(chars.join("") + "...", assets.fontNotoSb, valueFont), 7.0) > maxValWidth) {
          chars.pop();
        }
        displayVal = chars.join("") + "...";
        valueRuns = textRuns(displayVal, assets.fontNotoSb, valueFont);
      }

      let valueX = LEFT_MARGIN;
      for (const run of valueRuns) {
        page.drawText(run.text, {
          x: valueX, y: valYs[i], size: 7.0, font: run.font, color: COLOR_HEADING,
        });
        valueX += run.font.widthOfTextAtSize(run.text, 7.0);
      }
    }

    // 8. 右侧灰框侧边栏 (x=403, y=244, w=89, h=78, 灰底 #F8F8F8)
    page.drawRectangle({
      x: 403.0,
      y: 244.0,
      width: 89.0,
      height: 78.0,
      color: COLOR_BOX_BG,
    });

    // 侧边栏 3 行统计文本 (NotoSans-SemiBold 7pt, #191919)
    // Item 1: y=300 (Pages)
    // Item 2: y=278 (Words)
    // Item 3: y=256 (Characters)
    const pageCount = parseInt(subMeta && subMeta.page_count, 10) || 0;
    const wordCount = parseInt(subMeta && subMeta.word_count, 10) || 0;
    const charCount = parseInt(subMeta && subMeta.char_count, 10) || 0;

    page.drawText(`${pageCount} Pages`, {
      x: 415.0,
      y: 300.0,
      size: 7.0,
      font: assets.fontNotoSb,
      color: COLOR_HEADING,
    });

    page.drawText(`${formatNumber(wordCount)} Words`, {
      x: 415.0,
      y: 278.0,
      size: 7.0,
      font: assets.fontNotoSb,
      color: COLOR_HEADING,
    });

    page.drawText(`${formatNumber(charCount)} Characters`, {
      x: 415.0,
      y: 256.0,
      size: 7.0,
      font: assets.fontNotoSb,
      color: COLOR_HEADING,
    });

    // 9. 底部 Footer
    this.drawFooter(page, assets, 1, totalPages, "Cover Page", submissionID);

    return page;
  }
}

module.exports = {
  TIICoverRenderer,
  coverNames,
  PAGE_WIDTH,
  PAGE_HEIGHT,
  formatDT,
  formatSize,
  formatNumber,
  formatSubmissionID,
};
