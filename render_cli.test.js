const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { PDFDocument, PDFName, PDFArray, PDFRawStream, StandardFonts, decodePDFRawStream } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const { collectSimilarityData } = require("./engine/render_full");
const { TIISimilarityCoverRenderer, summarizeMatchGroups } = require("./engine/similarity_cover");
const { TIIAICoverRenderer } = require("./engine/ai_cover");
const { TIICoverRenderer, coverNames } = require("./engine/cover");

const assets = process.env.REPORT_RENDER_ASSETS_DIR || path.join(__dirname, "assets");

test("CLI help works without a manifest", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "render_cli.js"), "--help"], {encoding: "utf8"});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--manifest.*--output-dir/);
});

async function fixture(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "report-render-"));
  t.after(() => fs.rm(tmp, {recursive: true, force: true}));
  const input = path.join(tmp, "input");
  const output = path.join(tmp, "output");
  await fs.mkdir(input);
  await fs.mkdir(output);
  const pdf = await PDFDocument.create();
  pdf.addPage();
  await fs.writeFile(path.join(input, "blank.pdf"), await pdf.save());
  for (const [file, data] of Object.entries({
    "glyph.json": {pages: [1], glyph_data: [[]]},
    "submission.json": {filename: "Synthetic document", ingest_request_time: "2026-01-01"},
    "report.json": {},
    "overview.json": {taggedView: {}},
    "ai.json": {sentences: [], resultSummary: {rollupPercent: 0.95}},
  })) await fs.writeFile(path.join(input, file), JSON.stringify(data));
  const manifest = {
    version: 1, type: "similarity", metadata: {submission_id: "fixture:1", score_percent: 0},
    materials: {blank: "blank.pdf", glyph: "glyph.json", submission: "submission.json", report: "report.json", overview: "overview.json"},
  };
  const manifestPath = path.join(input, "manifest.json");
  return {
    input, output, manifest,
    async run() {
      await fs.writeFile(manifestPath, JSON.stringify(manifest));
      return spawnSync(process.execPath, [path.join(__dirname, "render_cli.js"), "--manifest", manifestPath, "--output-dir", output], {
        encoding: "utf8", timeout: 15_000,
      });
    },
  };
}

test("missing AI, path escapes and unknown scores are not success", async t => {
  const f = await fixture(t);
  f.manifest.type = "ai";
  f.manifest.materials.report = "missing.json";
  let r = await f.run();
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.stdout, "");
  const outside = path.join(f.output, "outside.json");
  await fs.writeFile(outside, JSON.stringify({sentences: []}));
  await fs.symlink(outside, path.join(f.input, "link.json"));
  f.manifest.materials.report = "link.json";
  r = await f.run();
  assert.equal(r.status, 3, r.stderr);
  f.manifest.metadata.score_percent = null;
  assert.equal((await f.run()).status, 2);
  f.manifest.metadata.score_percent = 0;
  f.manifest.metadata.author_name = {};
  assert.equal((await f.run()).status, 2);
  f.manifest.metadata.author_name = "William Jones";
  f.manifest.metadata.cover_name_seed = "";
  assert.equal((await f.run()).status, 2);
  assert.deepEqual(await fs.readdir(f.output), ["outside.json"]);
});

test("independent similarity and AI PDFs include the body and have verified hashes", {skip: !assets}, async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.input, "ai.json"));
  let r = await f.run();
  assert.equal(r.status, 0, r.stderr);
  for (const type of ["similarity", "ai"]) {
    if (type === "ai") {
      f.manifest.type = "ai";
      f.manifest.materials.report = "ai.json";
      await fs.writeFile(path.join(f.input, "ai.json"), JSON.stringify({sentences: []}));
      r = await f.run();
      assert.equal(r.status, 0, r.stderr);
    }
    const result = JSON.parse(r.stdout);
    assert.equal(result.type, type);
    const bytes = await fs.readFile(path.join(f.output, result.file));
    assert.equal(bytes.length, result.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), result.sha256);
    assert.equal((await PDFDocument.load(bytes)).getPageCount(), type === "ai" ? 3 : 4);
  }
});

test("Chinese cover filenames use semibold CJK and Latin fonts in both reports", {skip: !assets}, async t => {
  const f = await fixture(t);
  const name = "企业文化.docx";
  f.manifest.metadata.author_name = "William Jones";
  await fs.writeFile(path.join(f.input, "submission.json"), JSON.stringify({filename: name}));
  const cjk = fontkit.create(await fs.readFile(require.resolve("@expo-google-fonts/noto-sans-sc/600SemiBold/NotoSansSC_600SemiBold.ttf")));
  const latin = fontkit.create(await fs.readFile(path.join(assets, "subset-NotoSans-SemiBold.ttf")));
  const encode = (font, text) => font.layout(text).glyphs.map(g => g.id.toString(16).padStart(4, "0")).join("").toUpperCase();
  for (const type of ["similarity", "ai"]) {
    f.manifest.type = type;
    f.manifest.materials.report = type === "ai" ? "ai.json" : "report.json";
    const r = await f.run();
    assert.equal(r.status, 0, r.stderr);
    const doc = await PDFDocument.load(await fs.readFile(path.join(f.output, JSON.parse(r.stdout).file)));
    const fonts = doc.getPage(0).node.Resources().lookup(PDFName.of("Font"));
    const maps = fonts.keys().map(key => {
      const cmap = fonts.lookup(key).lookup(PDFName.of("ToUnicode"));
      return cmap instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(cmap).decode()).toString() : "";
    });
    const chinese = Array.from("企业文化").map(char => `<${char.charCodeAt(0).toString(16).padStart(4, "0")}>`);
    assert.ok(maps.some(map => chinese.every(char => map.toLowerCase().includes(char))), `${type} cover lacks Chinese glyph mappings`);
    assert.ok(fonts.keys().some(key => String(fonts.lookup(key).get(PDFName.of("BaseFont"))).includes("NotoSansSC-SemiBold")));
    const contents = doc.getPage(0).node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map(ref => doc.context.lookup(ref)) : [contents];
    const text = streams.filter(stream => stream instanceof PDFRawStream)
      .map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString()).join("\n");
    assert.match(text, new RegExp(`NotoSansSC-SemiBold[^\\s]* 7 Tf[\\s\\S]*?36 190 Tm\\s*<${encode(cjk, "企业文化")}> Tj`));
    assert.match(text, new RegExp(`NotoSans-SemiBold[^\\s]* 7 Tf[\\s\\S]*?190 Tm\\s*<${encode(latin, ".docx")}> Tj`));
  }
});

test("cover uses supplied author and filename rather than a separate title", {skip: !assets}, async t => {
  const f = await fixture(t);
  f.manifest.metadata.author_name = "Ada Lovelace";
  f.manifest.metadata.document_title = "Research title";
  f.manifest.metadata.document_name = "original.docx";
  const font = fontkit.create(await fs.readFile(path.join(assets, "LexendDeca-SemiBold.ttf")));
  const encoded = text => font.layout(text).glyphs.map(g => g.id.toString(16).padStart(4, "0")).join("").toUpperCase();
  for (const type of ["similarity", "ai"]) {
    f.manifest.type = type;
    f.manifest.materials.report = type === "ai" ? "ai.json" : "report.json";
    const r = await f.run();
    assert.equal(r.status, 0, r.stderr);
    const doc = await PDFDocument.load(await fs.readFile(path.join(f.output, JSON.parse(r.stdout).file)));
    const contents = doc.getPage(0).node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map(ref => doc.context.lookup(ref)) : [contents];
    const text = streams.filter(stream => stream instanceof PDFRawStream)
      .map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString()).join("\n");
    assert.match(text, new RegExp(`20 Tf[\\s\\S]*?36 436 Tm\\s*<${encoded("Ada Lovelace")}> Tj`));
    assert.match(text, new RegExp(`17 Tf[\\s\\S]*?36 406 Tm\\s*<${encoded("original")}> Tj`));
    const fonts = doc.getPage(0).node.Resources().lookup(PDFName.of("Font"));
    const maps = fonts.keys().map(key => {
      const cmap = fonts.lookup(key).lookup(PDFName.of("ToUnicode"));
      return cmap instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(cmap).decode()).toString() : "";
    });
    assert.ok(Array.from("original.docx").every(char => maps.some(map =>
      map.toLowerCase().includes(`<${char.charCodeAt(0).toString(16).padStart(4, "0")}>`))));
  }
});

test("mixed Chinese titles use the Latin heading font for Latin characters", {skip: !assets}, async t => {
  const f = await fixture(t);
  f.manifest.metadata.author_name = "William Jones";
  f.manifest.metadata.document_name = "修改改后(1).docx";
  const r = await f.run();
  assert.equal(r.status, 0, r.stderr);
  const doc = await PDFDocument.load(await fs.readFile(path.join(f.output, JSON.parse(r.stdout).file)));
  const fonts = doc.getPage(0).node.Resources().lookup(PDFName.of("Font"));
  const mediumKey = fonts.keys().find(key => String(fonts.lookup(key).get(PDFName.of("BaseFont"))).includes("NotoSansSC-Medium"));
  assert.ok(mediumKey, "Chinese title font missing");
  const font = fontkit.create(await fs.readFile(path.join(assets, "LexendDeca-SemiBold.ttf")));
  const encoded = font.layout("(1)").glyphs.map(g => g.id.toString(16).padStart(4, "0")).join("").toUpperCase();
  const contents = doc.getPage(0).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map(ref => doc.context.lookup(ref)) : [contents];
  const text = streams.filter(stream => stream instanceof PDFRawStream)
    .map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString()).join("\n");
  assert.match(text, new RegExp(`Lexend[^\\s]* 17 Tf[\\s\\S]*?<${encoded}> Tj`));
});

test("half-page threshold uses stable six-letter names and preserves the extension", () => {
  const font = {widthOfTextAtSize: text => text.length * 17};
  assert.deepEqual(coverNames("汉".repeat(18) + ".docx", "id-1", font),
    {title: "汉".repeat(18), filename: "汉".repeat(18) + ".docx"});
  const long = "汉".repeat(19) + ".docx";
  const names = coverNames(long, "id-1", font);
  assert.match(names.title, /^[A-Za-z]{6}$/);
  assert.equal(names.filename, names.title + ".docx");
  assert.deepEqual(coverNames(long, "id-1", font), names);
  assert.notEqual(coverNames(long, "id-2", font).title, names.title);
  assert.equal(coverNames("汉".repeat(19), "id-1", font).filename,
    coverNames("汉".repeat(19), "id-1", font).title);
});

test("both reports use the same replacement for title and filename", {skip: !assets}, async t => {
  const f = await fixture(t);
  const filename = "W".repeat(50) + ".docx";
  f.manifest.metadata.author_name = "William Jones";
  f.manifest.metadata.document_name = filename;
  f.manifest.metadata.cover_name_seed = "fixed-test-seed";
  const headingFont = fontkit.create(await fs.readFile(path.join(assets, "LexendDeca-SemiBold.ttf")));
  const detailFont = fontkit.create(await fs.readFile(path.join(assets, "subset-NotoSans-SemiBold.ttf")));
  const encode = (font, text) => font.layout(text).glyphs.map(g => g.id.toString(16).padStart(4, "0")).join("").toUpperCase();
  const names = coverNames(filename, "fixed-test-seed", {widthOfTextAtSize: () => 307});
  for (const type of ["similarity", "ai"]) {
    f.manifest.type = type;
    f.manifest.materials.report = type === "ai" ? "ai.json" : "report.json";
    const r = await f.run();
    assert.equal(r.status, 0, r.stderr);
    const doc = await PDFDocument.load(await fs.readFile(path.join(f.output, JSON.parse(r.stdout).file)));
    const contents = doc.getPage(0).node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map(ref => doc.context.lookup(ref)) : [contents];
    const text = streams.filter(stream => stream instanceof PDFRawStream)
      .map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString()).join("\n");
    assert.match(text, new RegExp(`17 Tf[\\s\\S]*?36 406 Tm\\s*<${encode(headingFont, names.title)}> Tj`));
    assert.match(text, new RegExp(`7 Tf[\\s\\S]*?36 190 Tm\\s*<${encode(detailFont, names.filename)}> Tj`));
  }
});

test("bundled Chinese fonts work without system or asset-directory CJK fonts", async t => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const preferred = await doc.embedFont(StandardFonts.Helvetica);
  const renderer = new TIICoverRenderer(await fs.mkdtemp(path.join(os.tmpdir(), "cjk-font-")));
  t.after(() => fs.rm(renderer.resDir, {recursive: true, force: true}));
  const fonts = {};
  const titleFont = await renderer.documentNameFont(doc, "中文标题", preferred, fonts, "medium");
  const fileFont = await renderer.documentNameFont(doc, "中文标题.docx", preferred, fonts, "semibold");
  assert.match(titleFont.name, /NotoSansSC-Medium/);
  assert.match(fileFont.name, /NotoSansSC-SemiBold/);
  const page = doc.addPage();
  page.drawText("修改改后", {font: titleFont, size: 17});
  page.drawText("中文标题.docx", {font: fileFont, size: 7});
  const saved = await PDFDocument.load(await doc.save());
  const pdfFonts = saved.getPage(0).node.Resources().lookup(PDFName.of("Font"));
  const embedded = pdfFonts.lookup(pdfFonts.keys()[0]).lookup(PDFName.of("DescendantFonts")).lookup(0);
  const descriptor = embedded.lookup(PDFName.of("FontDescriptor"));
  const font = fontkit.create(decodePDFRawStream(descriptor.lookup(PDFName.of("FontFile2"))).decode());
  for (const char of "修改后") {
    const glyph = font.glyphForCodePoint(char.codePointAt(0));
    assert.ok(glyph.path.commands.length > 0 && Number.isFinite(glyph.bbox.maxY), `missing glyph: ${char}`);
  }
  const fileKey = pdfFonts.keys().find(key => String(pdfFonts.lookup(key).get(PDFName.of("BaseFont"))).includes("NotoSansSC-SemiBold"));
  const fileDescendant = pdfFonts.lookup(fileKey).lookup(PDFName.of("DescendantFonts")).lookup(0);
  const fileDescriptor = fileDescendant.lookup(PDFName.of("FontDescriptor"));
  const embeddedFileFont = fontkit.create(decodePDFRawStream(fileDescriptor.lookup(PDFName.of("FontFile2"))).decode());
  for (const char of "企业文化") {
    const glyph = embeddedFileFont.glyphForCodePoint(char.codePointAt(0));
    assert.ok(glyph.path.commands.length > 0 && glyph.bbox.maxY > 800, `missing filename glyph: ${char}`);
  }
});

test("student paper dates are shown only when the grouped sources agree", () => {
  const index = {segmentsToRects: () => []};
  const sources = dates => dates.map(submittedDate => ({submittedDate}));
  const taggedView = {matches: {matchAggregates: [
    {collection: "SUBMITTED_WORK", linkText: "University", matchSources: sources(["2026-11-06"])},
    {collection: "SUBMITTED_WORK", linkText: "University", matchSources: sources(["2026-11-06", "2026-11-16"])},
    {collection: "SUBMITTED_WORK", linkText: "University", matchSources: sources(["2026-11-06", null])},
    {collection: "PUBLICATION", linkText: "Publication title", matchSources: []},
  ]}};
  const {aggregates} = collectSimilarityData(index, {taggedView}, () => 1);
  const text = [];
  const page = {
    drawSvgPath() {}, drawLine() {},
    drawText(value) { text.push(value); },
  };
  const font = {widthOfTextAtSize: value => Array.from(value).length * 5};
  const renderer = new TIISimilarityCoverRenderer();
  for (const agg of aggregates) renderer.drawTopSourceRow(page, {fontNotoSb: font}, agg, 546.5);
  assert.ok(text.includes("University on 2026-11-06"));
  assert.equal(text.filter(value => value === "Student papers").length, 3);
  assert.equal(text.filter(value => value === "University").length, 2);
  assert.ok(text.includes("Publication"));
  assert.ok(text.includes("Publication title"));
});

test("match groups use tagged categories, counts and percentages, defaulting empty entries to zero", () => {
  const tagged = {
    "!cited,!quoted": {overallMatchPercentage: 3.79, matchAggregates: [
      {matchSources: [{matchGroups: [{}, {}]}, {matchGroups: [{}]}]},
      {matchSources: [{matchGroups: [{}]}]},
    ]},
    "cited,!quoted": {overallMatchPercentage: 0.4, matchAggregates: [{matchSources: [{matchGroups: [{}]}]}]},
    "!cited,quoted": {overallMatchPercentage: 1.6},
  };
  assert.deepEqual(summarizeMatchGroups(tagged), [
    {count: 4, percent: 3.79}, {count: 1, percent: 0.4},
    {count: 0, percent: 1.6}, {count: 0, percent: 0},
  ]);
  assert.throws(() => summarizeMatchGroups({"cited,quoted": {overallMatchPercentage: "invalid"}}), /Invalid match group percentage/);
  assert.throws(() => summarizeMatchGroups({"!cited,!quoted": {matchAggregates: {}}}), /Invalid match group aggregates/);
});

test("both similarity overview pages render match group counts and percentages", {skip: !assets}, async t => {
  const f = await fixture(t);
  const aggregate = count => ({matchSources: [{matchGroups: Array.from({length: count}, () => ({}))}]});
  await fs.writeFile(path.join(f.input, "overview.json"), JSON.stringify({taggedView: {
    "!cited,!quoted": {overallMatchPercentage: 3.79, matchAggregates: [aggregate(12)]},
    "cited,!quoted": {overallMatchPercentage: 0.4, matchAggregates: [aggregate(1)]},
    "!cited,quoted": {overallMatchPercentage: 1.6, matchAggregates: [aggregate(2)]},
    "cited,quoted": {},
  }}));
  const r = await f.run();
  assert.equal(r.status, 0, r.stderr);
  const doc = await PDFDocument.load(await fs.readFile(path.join(f.output, JSON.parse(r.stdout).file)));
  const regular = fontkit.create(await fs.readFile(path.join(assets, "subset-NotoSans-Regular.ttf")));
  const semibold = fontkit.create(await fs.readFile(path.join(assets, "subset-NotoSans-SemiBold.ttf")));
  const encode = (font, value) => font.layout(value).glyphs.map(g => g.id.toString(16).padStart(4, "0")).join("").toUpperCase();
  for (const [pageIndex, firstY] of [[1, 599.5], [2, 708]]) {
    const contents = doc.getPage(pageIndex).node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map(ref => doc.context.lookup(ref)) : [contents];
    const text = streams.filter(stream => stream instanceof PDFRawStream)
      .map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString()).join("\n");
    const rows = [["12", "Not Cited or Quoted  4%"], ["1", "Missing Quotations  <1%"],
      ["2", "Missing Citation  2%"], ["0", "Cited and Quoted  0%"]];
    rows.forEach(([count, label], i) => {
      const y = firstY - i * 25;
      assert.match(text, new RegExp(`53 ${y} Tm\\s*<${encode(semibold, count)}> Tj`));
      assert.match(text, new RegExp(`${y} Tm\\s*<${encode(regular, label)}> Tj`));
    });
  }
});

test("long student paper names retain their date without overlapping the percentage", () => {
  const text = [];
  const page = {drawSvgPath() {}, drawLine() {}, drawText(value) { text.push(value); }};
  const font = {widthOfTextAtSize: value => Array.from(value).length * 5};
  const renderer = new TIISimilarityCoverRenderer();
  renderer.drawTopSourceRow(page, {fontNotoSb: font}, {
    collection: "SUBMITTED_WORK", linkText: "University ".repeat(20), submittedDate: "2026-11-06",
  }, 546.5);
  const title = text.find(value => value.endsWith(" on 2026-11-06"));
  assert.ok(title.includes("…"));
  assert.ok(font.widthOfTextAtSize(title, 8) <= 340);
});

test("AI heading uses Lexend Deca Medium at the reference width", {skip: !assets}, async () => {
  const doc = await PDFDocument.create();
  const renderer = new TIIAICoverRenderer(assets);
  const {fontAIHeading} = await renderer.loadAIAssets(doc);
  const width = fontAIHeading.widthOfTextAtSize("*% detected as AI", 17);
  assert.ok(Math.abs(width - 150.636) < 0.3, `unexpected AI heading width: ${width}`);
  const page = doc.addPage();
  page.drawText("*% detected as AI", {font: fontAIHeading, size: 17});
  const saved = await PDFDocument.load(await doc.save());
  const fonts = saved.getPage(0).node.Resources().lookup(PDFName.of("Font"));
  const embedded = fonts.lookup(fonts.keys()[0]);
  const descendant = embedded.lookup(PDFName.of("DescendantFonts")).lookup(0);
  const descriptor = descendant.lookup(PDFName.of("FontDescriptor"));
  const data = decodePDFRawStream(descriptor.lookup(PDFName.of("FontFile2"))).decode();
  const font = fontkit.create(data);
  assert.equal(font.postscriptName, "LexendDeca-Medium");
  const glyph = font.glyphForCodePoint("*".codePointAt(0));
  assert.ok(glyph.bbox.maxY > 0 && glyph.bbox.maxY < font.unitsPerEm);
});

test("AI disclaimer lines frame the three-line text and the FAQ is absent", {skip: !assets}, async () => {
  const semibold = fontkit.create(await fs.readFile(path.join(assets, "subset-NotoSans-SemiBold.ttf")));
  const encode = value => semibold.layout(value).glyphs.map(g => g.id.toString(16).padStart(4, "0")).join("").toUpperCase();
  for (const [score, top, bottom, header, lastLine] of [
    [0.1, 644, 580, 620, 596],
    [0, 592, 528, 568, 544],
  ]) {
    const doc = await PDFDocument.create();
    const renderer = new TIIAICoverRenderer(assets);
    await renderer.renderAICoverPages(doc, {}, {rollupPercent: score}, "fixture:1", 2);
    const saved = await PDFDocument.load(await doc.save());
    const contents = saved.getPage(1).node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map(ref => saved.context.lookup(ref)) : [contents];
    const operators = streams.filter(stream => stream instanceof PDFRawStream)
      .map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString()).join("\n");
    for (const y of [top, bottom]) {
      assert.match(operators, new RegExp(`36 ${y} m[\\s\\S]*?576 ${y} l`));
    }
    assert.match(operators, new RegExp(`36 ${header} Tm\\s*<${encode("Disclaimer")}> Tj`));
    assert.match(operators, new RegExp(`36 ${lastLine} Tm`));
    assert.ok(!operators.includes(`<${encode("Frequently Asked Questions")}>`));
  }
});

test("AI overview renders the official single group from summary data", {skip: !assets}, async t => {
  const regular = fontkit.create(await fs.readFile(path.join(assets, "subset-NotoSans-Regular.ttf")));
  const semibold = fontkit.create(await fs.readFile(path.join(assets, "subset-NotoSans-SemiBold.ttf")));
  const heading = fontkit.create(await fs.readFile(require.resolve("@expo-google-fonts/lexend-deca/500Medium/LexendDeca_500Medium.ttf")));
  const encode = (font, value) => font.layout(value).glyphs.map(g => g.id.toString(16).padStart(4, "0")).join("").toUpperCase();
  for (const {score, count, expectedCount, suppressed} of [
    {score: 58, count: 26, expectedCount: "26", suppressed: false},
    {score: 0, count: 0, expectedCount: "0", suppressed: false},
    {score: 20, count: 4, expectedCount: "4", suppressed: false},
    {score: 58, expectedCount: "-", suppressed: false},
    {score: 0.1, count: 1, suppressed: true},
    {score: 19.9, count: 8, suppressed: true},
  ]) {
    const f = await fixture(t);
    f.manifest.type = "ai";
    f.manifest.metadata.score_percent = score;
    f.manifest.materials.report = "ai.json";
    await fs.writeFile(path.join(f.input, "ai.json"), JSON.stringify({
      sentences: [], resultSummary: {aiwSentenceCount: count, rollupPercent: 0.5},
    }));
    const r = await f.run();
    assert.equal(r.status, 0, r.stderr);
    const doc = await PDFDocument.load(await fs.readFile(path.join(f.output, "ai.pdf")));
    const contents = doc.getPage(1).node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map(ref => doc.context.lookup(ref)) : [contents];
    const operators = streams.filter(stream => stream instanceof PDFRawStream)
      .map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString()).join("\n");
    const title = suppressed ? "*% detected as AI" : `${score}% detected as AI`;
    assert.ok(operators.includes(`<${encode(heading, title)}>`), `incorrect heading for ${score}`);
    const groupLabel = `<${encode(regular, "AI-generated")}>`;
    if (suppressed) {
      assert.ok(!operators.includes(groupLabel), `unexpected group for ${score}`);
    } else {
      assert.ok(operators.includes(groupLabel), `missing group for ${score}`);
      assert.match(operators, new RegExp(`52 618 Tm\\s*<${encode(semibold, expectedCount)}> Tj`));
      assert.ok(operators.includes(`<${encode(regular, `${score}%`)}>`));
    }
    assert.ok(!operators.includes(`<${encode(regular, "AI-generated text that was AI-paraphrased")}>`));
  }
});
