const { rgb } = require("pdf-lib");

// 页面几何常量 (US Letter 612x792)
const PAGE_WIDTH = 612.0;
const PAGE_HEIGHT = 792.0;
const LEFT_MARGIN_X = 36.0;
const RIGHT_MARGIN_X = 576.0;

// TopSourcePalette (饱和色, 淡底色, 正文高亮色)
const TOP_SOURCE_PALETTE = [
  // #1 pink: 饱和 #CB1375, 标签 #FEDCE7, 正文高亮 #F8A2C4
  {
    sat: rgb(0.7961, 0.0745, 0.4588),
    pale: rgb(0.9961, 0.8627, 0.9059),
    highlight: rgb(0.9725, 0.6353, 0.7686),
  },
  // #2 blue: 饱和 #215DC6, 标签 #D6E5FB, 正文高亮 #A2C4F8
  {
    sat: rgb(0.1294, 0.3647, 0.7765),
    pale: rgb(0.8392, 0.8980, 0.9843),
    highlight: rgb(0.6353, 0.7686, 0.9725),
  },
  // #3 green: 饱和 #007445, 标签 #C1ECDF, 正文高亮 #7BDDBF
  {
    sat: rgb(0.0000, 0.4549, 0.2706),
    pale: rgb(0.7569, 0.9255, 0.8745),
    highlight: rgb(0.4824, 0.8667, 0.7490),
  },
  // #4 purple: 饱和 #7432E7, 标签 #ECDFFE, 正文高亮 #CAA6FD
  {
    sat: rgb(0.4549, 0.1961, 0.9059),
    pale: rgb(0.9255, 0.8745, 0.9961),
    highlight: rgb(0.7922, 0.6510, 0.9922),
  },
];

function getNumberColor(index1Based) {
  let idx = (index1Based - 1) % TOP_SOURCE_PALETTE.length;
  if (idx < 0) idx += TOP_SOURCE_PALETTE.length;
  return TOP_SOURCE_PALETTE[idx].sat;
}

function getLabelColor(index1Based) {
  let idx = (index1Based - 1) % TOP_SOURCE_PALETTE.length;
  if (idx < 0) idx += TOP_SOURCE_PALETTE.length;
  return TOP_SOURCE_PALETTE[idx].pale;
}

function getBodyHighlightColor(index1Based) {
  let idx = (index1Based - 1) % TOP_SOURCE_PALETTE.length;
  if (idx < 0) idx += TOP_SOURCE_PALETTE.length;
  return TOP_SOURCE_PALETTE[idx].highlight;
}

// AI 高亮配置 (青色 #52C6DA)
const AI_HIGHLIGHT_COLOR = rgb(82 / 255, 198 / 255, 218 / 255);
const AI_HIGHLIGHT_ALPHA = 0.4;

function generateRandomSubmissionID() {
  const n1 = Math.floor(Math.random() * 9000) + 1000;
  const n2 = Math.floor(Math.random() * 900000000) + 100000000;
  return `trn:oid:::${n1}:${n2}`;
}

module.exports = {
  PAGE_WIDTH,
  PAGE_HEIGHT,
  LEFT_MARGIN_X,
  RIGHT_MARGIN_X,
  TOP_SOURCE_PALETTE,
  getNumberColor,
  getLabelColor,
  getBodyHighlightColor,
  AI_HIGHLIGHT_COLOR,
  AI_HIGHLIGHT_ALPHA,
  generateRandomSubmissionID,
};
