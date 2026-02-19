import fs from "node:fs/promises";
import * as fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { PNG } from "pngjs";

const VIEWPORT = { width: 1280, height: 720 };
const OVERLAY_TIMEOUT_MS = 20_000;
const FRAME_DELTA_MS = 600;

function parseArgs(argv) {
  const args = { url: null, chrome: null, outDir: null, samplePoints: 400 };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--chrome") {
      args.chrome = argv[i + 1];
      i++;
      continue;
    }

    if (a === "--outDir") {
      args.outDir = argv[i + 1];
      i++;
      continue;
    }

    if (a === "--samplePoints") {
      args.samplePoints = Number(argv[i + 1]) || args.samplePoints;
      i++;
      continue;
    }

    if (!a.startsWith("-") && !args.url) {
      args.url = a;
    }
  }

  return args;
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveChromePath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);

  for (const p of candidates) {
    if (await fileExists(p)) return p;
  }

  return null;
}

async function importPuppeteer() {
  try {
    return { mod: await import("puppeteer"), flavor: "puppeteer" };
  } catch {}

  try {
    return { mod: await import("puppeteer-core"), flavor: "puppeteer-core" };
  } catch {}

  throw new Error("Missing dependency: install puppeteer or puppeteer-core");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readPng(filePath) {
  const buf = fsSync.readFileSync(filePath);
  return PNG.sync.read(buf);
}

function computePixelDiff(pngA, pngB, { threshold = 20 } = {}) {
  if (pngA.width !== pngB.width || pngA.height !== pngB.height) {
    throw new Error(`PNG size mismatch: ${pngA.width}x${pngA.height} vs ${pngB.width}x${pngB.height}`);
  }

  const w = pngA.width;
  const h = pngA.height;
  const totalPixels = w * h;

  let changed = 0;
  let sumAbs = 0;

  const a = pngA.data;
  const b = pngB.data;

  for (let i = 0; i < totalPixels; i++) {
    const ix = i * 4;

    const dr = Math.abs(a[ix + 0] - b[ix + 0]);
    const dg = Math.abs(a[ix + 1] - b[ix + 1]);
    const db = Math.abs(a[ix + 2] - b[ix + 2]);

    const mean = (dr + dg + db) / 3;
    sumAbs += mean;

    if (mean > threshold) changed++;
  }

  return {
    threshold,
    changedPercent: (changed / totalPixels) * 100,
    meanAbsDiff: sumAbs / totalPixels,
  };
}

function computeSobelEdgeMagnitude(png) {
  const w = png.width;
  const h = png.height;
  const total = w * h;

  const gray = new Float32Array(total);
  const data = png.data;

  for (let i = 0; i < total; i++) {
    const ix = i * 4;
    const r = data[ix + 0];
    const g = data[ix + 1];
    const b = data[ix + 2];
    gray[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const out = new Uint8Array(total);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;

      const tl = gray[i - w - 1];
      const tc = gray[i - w];
      const tr = gray[i - w + 1];
      const ml = gray[i - 1];
      const mr = gray[i + 1];
      const bl = gray[i + w - 1];
      const bc = gray[i + w];
      const br = gray[i + w + 1];

      const gx = -tl + tr + -2 * ml + 2 * mr + -bl + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;

      const mag = Math.min(255, Math.hypot(gx, gy) / 4);
      out[i] = mag;
    }
  }

  return { w, h, data: out };
}

function computeEdgeDiff(edgeA, edgeB, { threshold = 20 } = {}) {
  if (edgeA.w !== edgeB.w || edgeA.h !== edgeB.h) {
    throw new Error(`Edge size mismatch: ${edgeA.w}x${edgeA.h} vs ${edgeB.w}x${edgeB.h}`);
  }

  const totalPixels = edgeA.w * edgeA.h;

  let changed = 0;
  let sumAbs = 0;

  for (let i = 0; i < totalPixels; i++) {
    const d = Math.abs(edgeA.data[i] - edgeB.data[i]);
    sumAbs += d;
    if (d > threshold) changed++;
  }

  return {
    threshold,
    changedPercent: (changed / totalPixels) * 100,
    meanAbsDiff: sumAbs / totalPixels,
  };
}

function avgAbsDelta(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return null;
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.url) {
    throw new Error(
      "Usage: node scripts/heart_dynamic_verify.mjs <url> [--chrome <path>] [--outDir <path>] [--samplePoints <n>]"
    );
  }

  const outDir = args.outDir
    ? path.resolve(args.outDir)
    : path.join(os.tmpdir(), `heart-qa-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(outDir, { recursive: true });

  const { mod: puppeteer, flavor } = await importPuppeteer();

  const launchOpts = {
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--use-gl=egl",
    ],
  };

  if (flavor === "puppeteer-core") {
    const chromePath = await resolveChromePath(args.chrome);
    if (!chromePath) {
      throw new Error(
        "puppeteer-core requires a Chrome/Chromium executable. Provide --chrome <path> or set CHROME_PATH/PUPPETEER_EXECUTABLE_PATH."
      );
    }
    launchOpts.executablePath = chromePath;
  } else if (args.chrome) {
    launchOpts.executablePath = args.chrome;
  }

  const report = {
    url: args.url,
    viewport: VIEWPORT,
    overlayGone: false,
    overlayWaitMs: null,
    heartOk: null,
    cdnsTried: null,
    frames: {},
    pixelDiff: {},
    edgeDiff: {},
    positionDelta: {
      samplePoints: args.samplePoints,
      avgAbsDelta: {},
    },
    meta: {
      outDir,
      puppeteer: flavor,
    },
  };

  const browser = await puppeteer.launch(launchOpts);

  try {
    const page = await browser.newPage();
    await page.setViewport({ ...VIEWPORT, deviceScaleFactor: 1 });

    await page.goto(args.url, { waitUntil: "domcontentloaded" });

    const overlayStart = Date.now();
    try {
      await page.waitForFunction(
        () => !document.querySelector("#overlay") || window.__HEART_OK__ === true,
        { timeout: OVERLAY_TIMEOUT_MS }
      );
      report.overlayGone = true;
    } catch {
      report.overlayGone = false;
    }

    report.overlayWaitMs = Date.now() - overlayStart;

    const getDebugSnapshot = async () => {
      return await page.evaluate((samplePoints) => {
        const dbg = window.__HEART_DEBUG__;

        function sampleLayer(points) {
          if (!points || !points.geometry || !points.geometry.attributes) return null;
          const posAttr = points.geometry.attributes.position;
          if (!posAttr || !posAttr.array) return null;

          const arr = posAttr.array;
          const maxFloats = Math.min(arr.length, samplePoints * 3);
          const head = Array.from(arr.slice(0, maxFloats));
          return {
            totalFloats: arr.length,
            sampledFloats: maxFloats,
            head,
          };
        }

        return {
          heartOk: window.__HEART_OK__ === true,
          cdnsTried: window.__HEART_CDNS_TRIED__ || null,
          layers: {
            heartFill: sampleLayer(dbg && dbg.heartFill),
            heartEdge: sampleLayer(dbg && dbg.heartEdge),
            outerDust: sampleLayer(dbg && dbg.outerDust),
            sparkle: sampleLayer(dbg && dbg.sparkle),
          },
        };
      }, args.samplePoints);
    };

    const takeFrame = async (label) => {
      const filePath = path.join(outDir, `${label}.png`);
      await page.screenshot({ path: filePath });
      report.frames[label] = filePath;
      return filePath;
    };

    const snapT0 = await getDebugSnapshot();
    report.heartOk = snapT0.heartOk;
    report.cdnsTried = snapT0.cdnsTried;

    const t0Path = await takeFrame("t0");

    await sleep(FRAME_DELTA_MS);
    const snapT06 = await getDebugSnapshot();
    const t06Path = await takeFrame("t0.6");

    await sleep(FRAME_DELTA_MS);
    const t12Path = await takeFrame("t1.2");

    for (const [layerName, layer] of Object.entries(snapT0.layers || {})) {
      const a = layer && layer.head;
      const b = snapT06.layers && snapT06.layers[layerName] && snapT06.layers[layerName].head;
      report.positionDelta.avgAbsDelta[layerName] = avgAbsDelta(a, b);
    }

    const pngT0 = readPng(t0Path);
    const pngT06 = readPng(t06Path);
    const pngT12 = readPng(t12Path);

    report.pixelDiff["t0_vs_t0.6"] = computePixelDiff(pngT0, pngT06);
    report.pixelDiff["t0.6_vs_t1.2"] = computePixelDiff(pngT06, pngT12);
    report.pixelDiff["t0_vs_t1.2"] = computePixelDiff(pngT0, pngT12);

    const edgeT0 = computeSobelEdgeMagnitude(pngT0);
    const edgeT06 = computeSobelEdgeMagnitude(pngT06);
    const edgeT12 = computeSobelEdgeMagnitude(pngT12);

    report.edgeDiff["t0_vs_t0.6"] = computeEdgeDiff(edgeT0, edgeT06);
    report.edgeDiff["t0.6_vs_t1.2"] = computeEdgeDiff(edgeT06, edgeT12);
    report.edgeDiff["t0_vs_t1.2"] = computeEdgeDiff(edgeT0, edgeT12);
  } finally {
    await browser.close();
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((err) => {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: false,
        error: err && err.message ? String(err.message) : String(err),
        stack: err && err.stack ? String(err.stack) : null,
      },
      null,
      2
    )}\n`
  );
  process.exitCode = 1;
});
