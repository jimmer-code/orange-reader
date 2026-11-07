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

function stripRootSvgSize(svg) {
  // 去掉根 <svg> 的 width/height/style(max-width)，保留 viewBox 让 App 自适应宽度
  return svg.replace(/<svg\b[^>]*>/, (tag) => {
    let t = tag;
    t = t.replace(/\swidth="[^"]*"/, '');
    t = t.replace(/\sheight="[^"]*"/, '');
    t = t.replace(/\sstyle="[^"]*"/, '');
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

    const batch = Math.max(1, Math.min(4, args.maxParallel));
    for (let start = 0; start < items.length; start += batch) {
      const chunk = items.slice(start, start + batch);
      let rendered;
      try {
        rendered = await page.evaluate(async (chunk) => {
          const out = [];
          for (const item of chunk) {
            // 确定性 DOM id：同一段源码渲染出的 SVG 字节可复现，方便内容哈希去重
            const domId = String(item.dom_id || ('mm' + Math.random().toString(36).slice(2, 10)))
              .replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
            try {
              const r = await window.__kbMermaid.render(domId, String(item.code || ''));
              out.push({ id: item.id, svg: r && r.svg ? r.svg : '', error: null });
            } catch (err) {
              out.push({ id: item.id, svg: '', error: String((err && err.message) || err) });
            }
          }
          return out;
        }, chunk);
      } catch (err) {
        // 整个 evaluate 挂了（脚本错误/页面崩），逐张重试一次；仍失败记 error
        rendered = [];
        for (const item of chunk) {
          try {
            const r = await page.evaluate(async (item) => {
              const domId = String(item.dom_id || ('mm' + Math.random().toString(36).slice(2, 10)))
                .replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
              const out = await window.__kbMermaid.render(domId, String(item.code || ''));
              return { id: item.id, svg: (out && out.svg) || '', error: null };
            }, item);
            rendered.push(r);
          } catch (e2) {
            rendered.push({ id: item.id, svg: '', error: String((e2 && e2.message) || e2) });
          }
        }
        if (err && /Target closed|Session closed|Protocol error/i.test(String(err.message))) {
          throw err;
        }
      }
      for (const r of rendered) {
        if (!r || !r.svg || !r.svg.includes('<svg')) {
          results.errors.push({ id: r ? r.id : '?', error: (r && r.error) || 'empty svg' });
          continue;
        }
        const svg = stripRootSvgSize(r.svg);
        const name = await safeName(r.id);
        const file = path.join(args.outputDir, `${name}.svg`);
        await writeFile(file, svg, 'utf8');
        results.ok.push({ id: r.id, path: file, bytes: Buffer.byteLength(svg) });
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
