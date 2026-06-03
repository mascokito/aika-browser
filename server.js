import http from 'http';
import fs from 'fs';
import path from 'path';
import { handleProxy } from './proxy.js';
import {
  initPuppeteerBrowser,
  closePuppeteerBrowser,
  getPuppeteerHealth,
  getBrowser,
  renderHtmlWithPuppeteer,
} from './puppeteer-browser.js';

export { getBrowser, renderHtmlWithPuppeteer, getPuppeteerHealth };

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glsl': 'text/plain',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  res.on('error', (err) => {
    console.error('Response error:', err.message);
  });

  const pathname = req.url?.split('?')[0] || req.url;

  if (pathname === '/health') {
    const health = {
      ok: true,
      ...getPuppeteerHealth(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
    return;
  }

  if (pathname.startsWith('/proxy')) {
    return handleProxy(req, res);
  }

  let filePath = '.' + pathname;
  if (filePath === './') filePath = './preview.html';

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not found');
      } else {
        res.writeHead(500);
        res.end('Server error');
      }
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      res.end(content);
    }
  });
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} — closing Puppeteer browser…`);
  await closePuppeteerBrowser();
  server.close(() => {
    console.log('[server] HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function start() {
  try {
    await initPuppeteerBrowser();
  } catch (err) {
    console.warn(
      `[puppeteer] Browser not available at startup (${err.message}); HTML proxy will use fetch fallback`
    );
  }

  server.listen(PORT, () => {
    console.log(`Victoria Engine running on port ${PORT}`);
  });
}

start();
