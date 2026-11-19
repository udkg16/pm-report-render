#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { parseArgs } = require("node:util");
const { PDFDocument } = require("pdf-lib");
const { FullPureJSRenderer } = require("./engine/render_full");

const max = 100 * 1024 * 1024;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const within = (dir, file) => {
  const rel = path.relative(dir, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
};

class Failure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function localFile(dir, name, limit) {
  if (typeof name !== "string" || name === "" || path.isAbsolute(name) || /[:\\]/.test(name)) {
    throw new Error("invalid path");
  }
  const candidate = path.resolve(dir, name);
  if (!within(dir, candidate)) throw new Error("file outside input");
  const real = await fs.realpath(candidate);
  if (!within(dir, real)) throw new Error("link outside input");
  const stat = await fs.stat(real);
  if (!stat.isFile() || stat.size === 0 || stat.size > limit) throw new Error("invalid file size");
  return fs.readFile(real);
}

async function jsonFile(dir, name, limit = 16 * 1024 * 1024) {
  const value = JSON.parse((await localFile(dir, name, limit)).toString("utf8"));
  if (!object(value)) throw new Error("required JSON object");
  return value;
}

async function run() {
  let manifest, inputDir, outputDir, assets;
  try {
    const { values } = parseArgs({ options: {
      manifest: { type: "string" },
      "output-dir": { type: "string" },
      "assets-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    } });
    if (values.help) {
      console.log("Usage: report-render --manifest <manifest.json> --output-dir <directory> [--assets-dir <directory>]");
      return;
    }
    if (!values.manifest || !values["output-dir"]) throw new Error();
    const inputPath = path.resolve(values.manifest);
    inputDir = await fs.realpath(path.dirname(inputPath));
    manifest = await jsonFile(inputDir, path.basename(inputPath), 64 * 1024);
    const { type, metadata, materials } = manifest;
    if (manifest.version !== 1 || !["ai", "similarity"].includes(type) || !object(metadata) || !object(materials) ||
        typeof metadata.submission_id !== "string" || !metadata.submission_id.trim() ||
        typeof metadata.score_percent !== "number" || !Number.isFinite(metadata.score_percent) ||
        metadata.score_percent < 0 || metadata.score_percent > 100 ||
        ["author_name", "document_title", "document_name"].some(key =>
          metadata[key] !== undefined && typeof metadata[key] !== "string") ||
        (metadata.cover_name_seed !== undefined &&
          (typeof metadata.cover_name_seed !== "string" || !metadata.cover_name_seed.trim()))) throw new Error();
    outputDir = await fs.realpath(values["output-dir"]);
    if (inputDir === outputDir || within(inputDir, outputDir) || within(outputDir, inputDir)) throw new Error();
    assets = values["assets-dir"] || process.env.REPORT_RENDER_ASSETS_DIR || path.join(__dirname, "assets");
  } catch {
    throw new Failure(2, "invalid manifest, arguments, or directory layout");
  }

  const { type, metadata, materials } = manifest;
  let input;
  try {
    const [blankBytes, glyphData, subData, reportData, overviewData] = await Promise.all([
      localFile(inputDir, materials.blank, max),
      jsonFile(inputDir, materials.glyph),
      jsonFile(inputDir, materials.submission),
      jsonFile(inputDir, materials.report),
      type === "similarity" ? jsonFile(inputDir, materials.overview) : null,
    ]);
    if (type === "ai" ? !Array.isArray(reportData.sentences) : !object(overviewData.taggedView)) throw new Error();
    if ((await PDFDocument.load(blankBytes)).getPageCount() < 1) throw new Error();
    input = { blankBytes, glyphData, subData, reportData, overviewData };
  } catch {
    throw new Failure(3, "missing or invalid report materials");
  }

  const tmp = path.join(outputDir, `.render-${randomUUID()}.tmp`);
  const file = `${type}.pdf`;
  try {
    if (!assets) throw new Error();
    const renderer = new FullPureJSRenderer(await fs.realpath(assets));
    const bytes = await renderer.render(type, input, metadata);
    if (bytes.length > max || (await PDFDocument.load(bytes)).getPageCount() < 1) throw new Error();
    await fs.writeFile(tmp, bytes, { flag: "wx", mode: 0o600 });
    // Publish only validated bytes, and never overwrite a previous attempt.
    await fs.link(tmp, path.join(outputDir, file));
    console.log(JSON.stringify({version: 1, type, file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")}));
  } catch {
    throw new Failure(4, "render, PDF validation, or output publication failed; for Chinese filenames check the CJK font in the assets directory");
  } finally {
    await fs.unlink(tmp).catch(err => {
      if (err.code !== "ENOENT") console.error("could not remove renderer temporary file");
    });
  }
}

run().catch(err => {
  console.error(err instanceof Failure ? err.message : "unexpected renderer failure");
  process.exitCode = err instanceof Failure ? err.code : 4;
});
