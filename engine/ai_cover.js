const fs = require("fs");
const path = require("path");
const { rgb } = require("pdf-lib");
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
const COLOR_CAUTION_BG = rgb(208 / 255, 232 / 255, 249 / 255); // #D0E8F9
const COLOR_CAUTION_TEXT = rgb(45 / 255, 45 / 255, 45 / 255);

class TIIAICoverRenderer extends TIICoverRenderer {
  constructor(resDir) {
    super(resDir);
  }

  async loadAIAssets(doc) {
    const baseAssets = await this.loadAssets(doc);
    const lexendBytes = fs.readFileSync(require.resolve("@expo-google-fonts/lexend-deca/500Medium/LexendDeca_500Medium.ttf"));
    const fontAIHeading = await doc.embedFont(lexendBytes);
    let aiStatIcon = null;

    const iconPath = path.join(this.resDir, "ai-stat-icon.png");
    if (fs.existsSync(iconPath)) {
      aiStatIcon = await doc.embedPng(fs.readFileSync(iconPath));
    }
    return {
      ...baseAssets,
      fontAIHeading,
      aiStatIcon,
    };
  }

  /**
   * 绘制 AI 报告的两页封面 (第 1 页 Cover Page, 第 2 页 AI Overview)
   */
  async renderAICoverPages(doc, subMeta, aiMeta, submissionID, totalPages) {
    // 第 1 页直接复用通用 Cover Page
    await this.renderCoverPage(doc, subMeta, submissionID, totalPages);

    // 第 2 页 AI Writing Overview
    const assets = await this.loadAIAssets(doc);
    const page2 = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

    this.drawHeader(page2, assets, 2, totalPages, "AI Writing Overview", submissionID);

    // 正数低于 20% 使用抑制显示，明确的 0% 原样展示。
    const rawAIPct = Number(
      aiMeta && (aiMeta.rollupPercent !== undefined ? aiMeta.rollupPercent : aiMeta.aiwOnlyPercent !== undefined ? aiMeta.aiwOnlyPercent : aiMeta.score)
    ) || 0;
    const percent = rawAIPct <= 1 && rawAIPct > 0 ? rawAIPct * 100 : rawAIPct;
    const pct = Math.round(percent);
    const isBelowThreshold = percent > 0 && percent < 20;

    const countLabel = n => Number.isInteger(n) && n >= 0 ? String(n) : "-";
    const aiwCount = countLabel(aiMeta?.aiwSentenceCount);

    // 顶部分割线 y = 732 (792 - 60)
    page2.drawLine({
      start: { x: LEFT_MARGIN, y: 732.0 },
      end: { x: RIGHT_MARGIN, y: 732.0 },
      thickness: 0.5,
      color: COLOR_LINE,
    });

    // 1. 标题与说明文字
    if (!isBelowThreshold) {
      // 正常显示模式（>= 20%）
      page2.drawText(`${pct}% detected as AI`, {
        x: LEFT_MARGIN,
        y: 694.0,
        size: 17.0,
        font: assets.fontAIHeading,
        color: COLOR_HEADING,
      });

      page2.drawText("The percentage indicates the combined amount of likely AI-generated text as", {
        x: LEFT_MARGIN,
        y: 684.0,
        size: 7.0,
        font: assets.fontNotoReg,
        color: COLOR_LABEL,
      });
      page2.drawText("well as likely AI-generated text that was also likely revised by AI.", {
        x: LEFT_MARGIN,
        y: 673.0,
        size: 7.0,
        font: assets.fontNotoReg,
        color: COLOR_LABEL,
      });
    } else {
      // 低于 20% 阈值（< 20%）统一使用官方 *% detected as AI 抑制模式
      page2.drawText("*% detected as AI", {
        x: LEFT_MARGIN,
        y: 694.0,
        size: 17.0,
        font: assets.fontAIHeading,
        color: COLOR_HEADING,
      });

      page2.drawText("AI detection includes the possibility of false positives. Although some text in", {
        x: LEFT_MARGIN,
        y: 684.0,
        size: 7.0,
        font: assets.fontNotoReg,
        color: COLOR_LABEL,
      });
      page2.drawText("this submission is likely AI generated, scores below the 20% threshold are not", {
        x: LEFT_MARGIN,
        y: 673.0,
        size: 7.0,
        font: assets.fontNotoReg,
        color: COLOR_LABEL,
      });
      page2.drawText("surfaced because they have a higher likelihood of false positives.", {
        x: LEFT_MARGIN,
        y: 662.0,
        size: 7.0,
        font: assets.fontNotoReg,
        color: COLOR_LABEL,
      });
    }

    // 2. 右侧 Caution 提示卡片 (浅蓝背景圆角框: x=306..571, y=660..716, w=265, h=56, r=8)
    const cautionSvg = `M 8 0 L 257 0 A 8 8 0 0 1 265 8 L 265 48 A 8 8 0 0 1 257 56 L 8 56 A 8 8 0 0 1 0 48 L 0 8 A 8 8 0 0 1 8 0 Z`;
    page2.drawSvgPath(cautionSvg, {
      x: 306.0,
      y: 716.0,
      color: COLOR_CAUTION_BG,
    });

    page2.drawText("Caution: Review required.", {
      x: 318.0,
      y: 700.0,
      size: 6.0,
      font: assets.fontNotoSb,
      color: COLOR_CAUTION_TEXT,
    });
    page2.drawText("It is essential to understand the limitations of AI detection before making decisions", {
      x: 318.0,
      y: 684.0,
      size: 6.0,
      font: assets.fontNotoReg,
      color: COLOR_CAUTION_TEXT,
    });
    page2.drawText("about a student's work. We encourage you to learn more about Turnitin's AI detection", {
      x: 318.0,
      y: 676.0,
      size: 6.0,
      font: assets.fontNotoReg,
      color: COLOR_CAUTION_TEXT,
    });
    page2.drawText("capabilities before using the tool.", {
      x: 318.0,
      y: 668.0,
      size: 6.0,
      font: assets.fontNotoReg,
      color: COLOR_CAUTION_TEXT,
    });

    // 3. 分割线 2 (y = 644)
    page2.drawLine({
      start: { x: LEFT_MARGIN, y: 644.0 },
      end: { x: RIGHT_MARGIN, y: 644.0 },
      thickness: 0.5,
      color: COLOR_LINE,
    });

    const showDetectionGroups = !isBelowThreshold;

    if (showDetectionGroups) {
      if (assets.aiStatIcon) {
        page2.drawImage(assets.aiStatIcon, {
          x: LEFT_MARGIN,
          y: 612.0,
          width: 12.0,
          height: 12.0,
        });
      }
      page2.drawText(aiwCount, {
        x: 52.0,
        y: 618.0,
        size: 7.0,
        font: assets.fontNotoSb,
        color: COLOR_HEADING,
      });
      const labelX = 52.0 + assets.fontNotoSb.widthOfTextAtSize(aiwCount, 7.0) + 4.0;
      page2.drawText("AI-generated", {
        x: labelX,
        y: 618.0,
        size: 7.0,
        font: assets.fontNotoReg,
        color: COLOR_HEADING,
      });
      const pctX = labelX + assets.fontNotoReg.widthOfTextAtSize("AI-generated", 7.0) + 5.0;
      page2.drawText(`${pct}%`, {
        x: pctX,
        y: 618.0,
        size: 7.0,
        font: assets.fontNotoReg,
        color: COLOR_HEADING,
      });
      page2.drawText("Likely generated or likely generated and revised by AI.", {
        x: 52.0,
        y: 608.0,
        size: 7.0,
        font: assets.fontNotoReg,
        color: COLOR_LABEL,
      });

      page2.drawLine({
        start: { x: LEFT_MARGIN, y: 592.0 },
        end: { x: RIGHT_MARGIN, y: 592.0 },
        thickness: 0.5,
        color: COLOR_LINE,
      });
    }

    // 5. Disclaimer 模块
    const discHeaderY = showDetectionGroups ? 568.0 : 620.0;
    page2.drawText("Disclaimer", {
      x: LEFT_MARGIN,
      y: discHeaderY,
      size: 6.0,
      font: assets.fontNotoSb,
      color: COLOR_LABEL,
    });

    const discLines = [
      "Our AI writing assessment is designed to help educators identify text that might be prepared by a generative AI tool. Our AI writing assessment may not always be accurate (it may misidentify",
      "writing that is likely human generated as AI generated and likely AI generated as human generated) so it should not be used as the sole basis for adverse actions against a student. It takes",
      "further scrutiny and human judgment in conjunction with an organization's application of its specific academic policies to determine whether any academic misconduct has occurred.",
    ];
    const discBaseY = showDetectionGroups ? 560.0 : 612.0;
    for (let i = 0; i < discLines.length; i++) {
      page2.drawText(discLines[i], {
        x: LEFT_MARGIN,
        y: discBaseY - i * 8.0,
        size: 6.0,
        font: assets.fontNotoReg,
        color: COLOR_LABEL,
      });
    }

    const disclaimerBottomLineY = showDetectionGroups ? 528.0 : 580.0;
    page2.drawLine({
      start: { x: LEFT_MARGIN, y: disclaimerBottomLineY },
      end: { x: RIGHT_MARGIN, y: disclaimerBottomLineY },
      thickness: 0.5,
      color: COLOR_LINE,
    });

    this.drawFooter(page2, assets, 2, totalPages, "AI Writing Overview", submissionID);

    return [page2];
  }
}

module.exports = {
  TIIAICoverRenderer,
};
