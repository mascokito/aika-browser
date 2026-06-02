/**
 * victoria-engine / runtime.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Main entry point. Supports two modes:
 *
 *   HEADLESS (victoria-core integration):
 *     node runtime.js --audio <path> --output <path> [--duration <seconds>]
 *
 *   PREVIEW (development):
 *     node runtime.js --preview
 *     Then open preview.html in a browser.
 *
 * In headless mode, Puppeteer launches a headless Chromium, loads preview.html
 * with the audio path injected, waits for the engine to signal completion, then
 * the recorded MP4 blob is transferred back via a WebSocket and written to disk.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import minimist from 'minimist';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = minimist(process.argv.slice(2), {
  string: ['audio', 'output'],
  number: ['duration', 'port'],
  boolean: ['preview', 'help'],
  default: {
    port: 9222,
    duration: 90,
  },
});

if (args.help) {
  console.log(`
victoria-engine — synthetic news anchor renderer

Usage:
  node runtime.js --audio <wav> --output <mp4>   Headless render
  node runtime.js --preview                       Dev preview server
  node runtime.js --help                          Show this help

Options:
  --audio    Path to input WAV audio file
  --output   Path for output MP4 (created if missing)
  --duration Max render duration in seconds (default: 90)
  --port     WebSocket port for headless bridge (default: 9222)
  --preview  Start a minimal dev HTTP server (no Puppeteer)
`);
  process.exit(0);
}

// ── Preview / dev mode ────────────────────────────────────────────────────────

if (args.preview || (!args.audio && !args.output)) {
  console.log('[victoria-engine] Preview mode — open preview.html in your browser.');
  console.log('[victoria-engine] No headless rendering in this mode.');
  process.exit(0);
}

// ── Headless render mode ──────────────────────────────────────────────────────

const audioPath = args.audio ? resolve(args.audio) : null;
const outputPath = args.output ? resolve(args.output) : null;

if (!audioPath || !outputPath) {
  console.error('[victoria-engine] ERROR: --audio and --output are required for headless render.');
  process.exit(1);
}

// Ensure output directory exists
const outDir = dirname(outputPath);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

console.log(`[victoria-engine] Starting headless render`);
console.log(`  Audio  : ${audioPath}`);
console.log(`  Output : ${outputPath}`);

// ── WebSocket bridge ──────────────────────────────────────────────────────────
// The browser-side engine sends status messages and the final MP4 blob
// back through this WS connection.

const wsPort = args.port;
const wss = new WebSocketServer({ port: wsPort });

wss.on('listening', () => {
  console.log(`[victoria-engine] WS bridge listening on ws://localhost:${wsPort}`);
  launchPuppeteer();
});

wss.on('connection', (ws) => {
  console.log('[victoria-engine] Browser connected to WS bridge');

  const chunks = [];

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Accumulate MP4 blob chunks
      chunks.push(data);
    } else {
      const msg = JSON.parse(data.toString());
      handleEngineMessage(msg, ws, chunks);
    }
  });
});

function handleEngineMessage(msg, ws, chunks) {
  switch (msg.type) {
    case 'READY':
      console.log('[victoria-engine] Engine ready — sending render config');
      ws.send(JSON.stringify({
        type: 'RENDER',
        audioUrl: `file://${audioPath}`,
        duration: args.duration,
      }));
      break;

    case 'PROGRESS':
      process.stdout.write(`\r[victoria-engine] Rendering… ${msg.percent.toFixed(1)}%`);
      break;

    case 'COMPLETE':
      process.stdout.write('\n');
      console.log('[victoria-engine] Render complete — saving MP4');
      if (chunks.length > 0) {
        const buffer = Buffer.concat(chunks);
        const wantsMp4 = outputPath.toLowerCase().endsWith('.mp4');
        const wantsWebm = outputPath.toLowerCase().endsWith('.webm');

        if (wantsMp4) {
          const webmPath = outputPath + '.webm';
          writeFileSync(webmPath, buffer);
          remuxWebmToMp4(webmPath, outputPath).then((ok) => {
            if (!ok) {
              console.warn('[victoria-engine] ffmpeg not available — keeping WebM container');
              try {
                renameSync(webmPath, outputPath);
              } catch (e) {
                console.warn('[victoria-engine] Failed to rename .webm to .mp4 path:', e?.message || e);
              }
            } else {
              try { unlinkSync(webmPath); } catch {}
            }
            console.log(`[victoria-engine] Saved: ${outputPath} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
            wss.close();
            process.exit(0);
          }).catch((e) => {
            console.warn('[victoria-engine] Remux failed — keeping WebM container:', e?.message || e);
            try {
              renameSync(webmPath, outputPath);
            } catch {}
            console.log(`[victoria-engine] Saved: ${outputPath} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
            wss.close();
            process.exit(0);
          });
          return; // async exit above
        }

        // Default: write whatever container we received (WebM)
        writeFileSync(outputPath, buffer);
        console.log(`[victoria-engine] Saved: ${outputPath} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
      }
      wss.close();
      process.exit(0);
      break;

    case 'ERROR':
      console.error(`[victoria-engine] Engine error: ${msg.message}`);
      wss.close();
      process.exit(1);
      break;

    default:
      console.log(`[victoria-engine] Engine: ${msg.type}`, msg);
  }
}

function remuxWebmToMp4(inputWebmPath, outputMp4Path) {
  return new Promise((resolve, reject) => {
    const args = ['-i', inputWebmPath, '-c:v', 'copy', '-c:a', 'copy', outputMp4Path];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      // ENOENT => ffmpeg not found
      if (err && err.code === 'ENOENT') return resolve(false);
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) return resolve(true);
      reject(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
    });
  });
}

// ── Puppeteer launch ──────────────────────────────────────────────────────────

async function launchPuppeteer() {
  // Dynamic import so the module isn't required in non-headless paths
  const { default: puppeteer } = await import('puppeteer');

  const previewPath = `file://${resolve(__dirname, 'preview.html')}`;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',       // allow file:// audio access
      '--allow-file-access-from-files',
      '--use-gl=angle',               // GPU accelerated WebGL
      '--enable-webgl',
      '--ignore-gpu-blocklist',
    ],
  });

  const page = await browser.newPage();

  // Inject config before page loads
  await page.evaluateOnNewDocument((wsPort) => {
    window.__VICTORIA_HEADLESS__ = true;
    window.__VICTORIA_WS_PORT__ = wsPort;
  }, wsPort);

  await page.goto(previewPath, { waitUntil: 'networkidle0' });

  // Surface browser console logs for debugging
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.error(`[browser] ${msg.text()}`);
    }
  });

  page.on('pageerror', (err) => {
    console.error(`[browser] Uncaught: ${err.message}`);
  });

  console.log('[victoria-engine] Puppeteer launched — waiting for engine');

  // Timeout safety
  setTimeout(() => {
    console.error('[victoria-engine] TIMEOUT — render exceeded max wait time');
    browser.close();
    wss.close();
    process.exit(1);
  }, (args.duration + 120) * 1000);
}
