#!/usr/bin/env node
// 批量把 mermaid 源码渲染成 SVG：puppeteer-core + 本机 Chrome + App 同款 Fusion Pixel 字体。
// 入口：node render_mermaid.mjs --input in.json --output-dir out/ [--chrome PATH] [--font PATH]
//       [--font-size 24] [--theme default] [--max-parallel 4]
// 输入 JSON：[{"id":"...","code":"flowchart ..."}, ...]
// 输出（stdout 单行 JSON）：{"ok":[{"id","path","bytes"}],"errors":[{"id","error"}]}
// 单图失败不拖垮整批；stderr 只放进度，stdout 必须是纯 JSON。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MERMAID_JS = path.join(HERE, 'node_modules/mermaid/dist/mermaid.min.js');

function parseArgs(argv) {
  const out = {
    input: '',
    outputDir: '',
    chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    font: '',
    fontSize: 24,
    theme: 'default',
    maxParallel: 4,
    timeoutMs: 120000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--input') out.input = next();
    else if (a === '--output-dir') out.outputDir = next();
    else if (a === '--chrome') out.chrome = next();
    else if (a === '--font') out.font = next();
    else if (a === '--font-size') out.fontSize = Number(next());
    else if (a === '--theme') out.theme = next();
    else if (a === '--max-parallel') out.maxParallel = Number(next());
    else if (a === '--timeout-ms') out.timeoutMs = Number(next());
    else if (a === '--help' || a === '-h') {
      console.log('usage: node render_mermaid.mjs --input in.json --output-dir out/ [--chrome PATH] [--font PATH]');
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  if (!out.input) throw new Error('--input is required');
  if (!out.outputDir) out.outputDir = path.join(HERE, 'state', 'mermaid-out');
  if (!Number.isFinite(out.fontSize) || out.fontSize < 8) out.fontSize = 24;
  if (!Number.isFinite(out.maxParallel) || out.maxParallel < 1) out.maxParallel = 4;
  return out;
}

// 暗色版配色：透明背景 + 卡片面 #26282c + 文字/边 #c9ccd1 + App accent 朱红 #a9471d
// 只改 themeVariables，不动物理布局；几何与浅色版保持一致（渲染后断言 viewBox 相等）
const DARK_THEME_VARIABLES = {
  background: 'transparent',
  primaryColor: '#26282c',
  primaryTextColor: '#c9ccd1',
  primaryBorderColor: '#a9471d',
  lineColor: '#c9ccd1',
  secondaryColor: '#2f3236',
  tertiaryColor: '#232528',
  textColor: '#c9ccd1',
  mainBkg: '#26282c',
  nodeBorder: '#a9471d',
  clusterBkg: '#1f2124',
  clusterBorder: '#3a3d42',
  edgeLabelBackground: '#26282c',
  titleColor: '#c9ccd1',
  actorBkg: '#26282c',
  actorBorder: '#a9471d',
  actorTextColor: '#c9ccd1',
  actorLineColor: '#c9ccd1',
  signalColor: '#c9ccd1',
  signalTextColor: '#c9ccd1',
  labelBoxBkgColor: '#26282c',
  labelBoxBorderColor: '#a9471d',
  labelTextColor: '#c9ccd1',
  loopTextColor: '#c9ccd1',
  noteBkgColor: '#2f3236',
  noteTextColor: '#c9ccd1',
  noteBorderColor: '#4a4d52',
  sectionBkgColor: '#26282c',
  altSectionBkgColor: '#232528',
  sectionBkgColor2: '#232528',
  taskBkgColor: '#26282c',
  taskTextColor: '#c9ccd1',
  taskTextOutsideColor: '#c9ccd1',
  taskBorderColor: '#4a4d52',
  activeTaskBkgColor: '#a9471d',
  activeTaskBorderColor: '#a9471d',
  doneTaskBkgColor: '#2f3236',
  doneTaskBorderColor: '#4a4d52',
  gridColor: '#3a3d42',
  todayLineColor: '#a9471d',
};

function stripRootSvgSize(svg, className) {
  // 去掉根 <svg> 的 width/height/style(max-width)，保留 viewBox 让 App 自适应宽度；
  // 并给根节点加 kb-mm-light / kb-mm-dark（App 据此切换显示）
  return svg.replace(/<svg\b[^>]*>/, (tag) => {
    let t = tag;
    t = t.replace(/\swidth="[^"]*"/, '');
    t = t.replace(/\sheight="[^"]*"/, '');
    t = t.replace(/\sstyle="[^"]*"/, '');
    if (/\sclass="/.test(t)) t = t.replace(/\sclass="([^"]*)"/, ` class="$1 ${className}"`);
    else t = t.replace('<svg', `<svg class="${className}"`);
    if (!/\sxmlns=/.test(t)) t = t.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    return t;
  });
}

async function safeName(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

async function renderAll(items, args) {
  const results = { ok: [], errors: [] };
  if (!items.length) return results;

  if (!existsSync(args.chrome)) throw new Error(`chrome not found: ${args.chrome}`);
  if (!existsSync(MERMAID_JS)) throw new Error(`mermaid bundle not found: ${MERMAID_JS}（先 npm install）`);
  if (args.font && !existsSync(args.font)) throw new Error(`font not found: ${args.font}`);

  await mkdir(args.outputDir, { recursive: true });

  const fontFace = args.font
    ? `@font-face { font-family: 'Fusion Pixel'; src: url('file://${args.font}') format('woff2'); font-display: block; }`
    : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFace}
html,body{margin:0;padding:0;background:#fff;}
svg{max-width:100%;}
</style></head><body><div id="mm-root"></div></body></html>`;

  const browser = await puppeteer.launch({
    executablePath: args.chrome,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(args.timeoutMs);
    await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });

    // 等字体真正可用，避免 mermaid 按 fallback 字体量尺寸
    try {
      await page.evaluate(async () => {
        if (document.fonts && document.fonts.load) await document.fonts.load("12px 'Fusion Pixel'");
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
        return true;
      });
    } catch { /* 字体加载失败也继续，只是字形可能回退 */ }

    await page.addScriptTag({ path: MERMAID_JS });
    await page.evaluate((cfg) => {
      window.__kbMermaid = window.mermaid;
      window.__kbMermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: cfg.theme,
        fontFamily: "'Fusion Pixel', sans-serif",
        fontSize: cfg.fontSize,
        flowchart: { htmlLabels: true, useMaxWidth: true, curve: 'basis' },
        sequence: { useMaxWidth: true },
        gantt: { useMaxWidth: true },
        // mermaid v11 只认 themeVariables.fontSize；顶层 fontSize 在 flowchart 里不生效
        themeVariables: { fontFamily: "'Fusion Pixel', sans-serif", fontSize: `${cfg.fontSize}px` },
      });
    }, { theme: args.theme, fontSize: args.fontSize });

    const meta = JSON.stringify({
      theme: args.theme,
      fontSize: args.fontSize,
      dark: DARK_THEME_VARIABLES,
    });
    const batch = Math.max(1, Math.min(4, args.maxParallel));
    for (let start = 0; start < items.length; start += batch) {
      const chunk = items.slice(start, start + batch);
      const rendered = await page.evaluate(async (chunk, meta) => {
        const cfg = JSON.parse(meta);
        const renderOne = async (code, domId) => {
          const r = await window.mermaid.render(domId, String(code || ''));
          return (r && r.svg) || '';
        };
        const out = [];
        for (const item of chunk) {
          const base = String(item.dom_id || ('mm' + Math.random().toString(36).slice(2, 10)))
            .replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 56);
          try {
            // 浅色
            window.mermaid.initialize({
              startOnLoad: false, securityLevel: 'loose', theme: cfg.theme,
              fontFamily: "'Fusion Pixel', sans-serif", fontSize: cfg.fontSize,
              flowchart: { htmlLabels: true, useMaxWidth: true, curve: 'basis' },
              sequence: { useMaxWidth: true }, gantt: { useMaxWidth: true },
              themeVariables: { fontFamily: "'Fusion Pixel', sans-serif", fontSize: `${cfg.fontSize}px` },
            });
            const light = await renderOne(item.code, base + 'L');
            // 暗色（只换 theme/themeVariables，布局参数保持一致）
            window.mermaid.initialize({
              startOnLoad: false, securityLevel: 'loose', theme: 'dark',
              fontFamily: "'Fusion Pixel', sans-serif", fontSize: cfg.fontSize,
              flowchart: { htmlLabels: true, useMaxWidth: true, curve: 'basis' },
              sequence: { useMaxWidth: true }, gantt: { useMaxWidth: true },
              themeVariables: {
                fontFamily: "'Fusion Pixel', sans-serif",
                fontSize: `${cfg.fontSize}px`,
                ...cfg.dark,
              },
            });
            const dark = await renderOne(item.code, base + 'D');
            const vb = (svg) => (String(svg).match(/viewBox="([^"]+)"/) || [])[1] || '';
            out.push({ id: item.id, light, dark, lightViewBox: vb(light), darkViewBox: vb(dark), error: null });
          } catch (err) {
            out.push({ id: item.id, light: '', dark: '', lightViewBox: '', darkViewBox: '',
                       error: String((err && err.message) || err) });
          }
        }
        return out;
      }, chunk, meta);

      for (const r of rendered) {
        if (!r.light || !r.dark || !r.light.includes('<svg') || !r.dark.includes('<svg')) {
          results.errors.push({ id: r.id, error: r.error || 'empty svg' });
          continue;
        }
        if (!r.lightViewBox || r.lightViewBox !== r.darkViewBox) {
          results.errors.push({
            id: r.id,
            error: `viewBox mismatch: light=${r.lightViewBox || '?'} dark=${r.darkViewBox || '?'}`,
          });
          continue;
        }
        const name = await safeName(r.id);
        const lightSvg = stripRootSvgSize(r.light, 'kb-mm-light');
        const darkSvg = stripRootSvgSize(r.dark, 'kb-mm-dark');
        const lightFile = path.join(args.outputDir, `${name}.light.svg`);
        const darkFile = path.join(args.outputDir, `${name}.dark.svg`);
        await writeFile(lightFile, lightSvg, 'utf8');
        await writeFile(darkFile, darkSvg, 'utf8');
        results.ok.push({
          id: r.id,
          light: lightFile,
          dark: darkFile,
          viewBox: r.lightViewBox,
          bytesLight: Buffer.byteLength(lightSvg),
          bytesDark: Buffer.byteLength(darkSvg),
        });
      }
      process.stderr.write(`[mermaid] ${Math.min(start + batch, items.length)}/${items.length}\n`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return results;
}

const args = parseArgs(process.argv);
const raw = await readFile(args.input, 'utf8');
const items = JSON.parse(raw);
if (!Array.isArray(items)) throw new Error('input JSON must be an array');
const results = await renderAll(items, args);
process.stdout.write(JSON.stringify(results) + '\n');
