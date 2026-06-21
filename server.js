import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleProxy, handleEmbedExtract, getAdblockerHealth } from './proxy.js';
import {
  closePuppeteerBrowser,
  getPuppeteerHealth,
  activeRenders,
} from './puppeteer-browser.js';

const PORT = process.env.PORT || 3000;
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** Prefer Referer (nested iframe context) over cookie for catch-all asset redirects. */
function extractProxyOrigin(req) {
  const referer = req.headers.referer || '';
  const refMatch = referer.match(/\/proxy\?url=([^&\s]+)/);
  if (refMatch) {
    try {
      return new URL(decodeURIComponent(refMatch[1])).origin;
    } catch {
      /* ignore */
    }
  }

  const cookieMatch = (req.headers.cookie || '').match(/aika_proxy_origin=([^;]+)/);
  if (cookieMatch) {
    try {
      return new URL(decodeURIComponent(cookieMatch[1])).origin;
    } catch {
      /* ignore */
    }
  }

  return null;
}

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

  let pathname = req.url?.split('?')[0] || req.url;

  if (pathname === '/health') {
    const mem = process.memoryUsage();
    const health = {
      ok: true,
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
      },
      puppeteer: getPuppeteerHealth(),
      adblocker: getAdblockerHealth(),
      activeRenders,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
    return;
  }

  if (pathname === '/proxy-embed') {
    return handleEmbedExtract(req, res);
  }

  if (pathname.startsWith('/proxy')) {
    return handleProxy(req, res);
  }

  if (pathname === '/manifest.json') {
    const manifestPath = path.join(projectRoot, 'manifest.json');
    try {
      const content = fs.readFileSync(manifestPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/manifest+json',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(content);
      return;
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
  }

  if (pathname.startsWith('/icons/')) {
    const iconPath = path.join(projectRoot, pathname);
    const iconsDir = path.join(projectRoot, 'icons');
    if (!iconPath.startsWith(iconsDir)) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const content = fs.readFileSync(iconPath);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(content);
      return;
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
  }

  const ASSET_INTERCEPT = /^\/((_app|_next|static|assets|dist|build|public|immutable)\/.+)$/;
  const assetMatch = pathname.match(ASSET_INTERCEPT);
  if (assetMatch) {
    const referer = req.headers.referer || '';
    console.log('[asset-intercept] pathname:', pathname, '| referer:', referer || '(none)');
    const originalSite = extractProxyOrigin(req);
    if (originalSite) {
      const query = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      const redirectUrl =
        '/proxy?url=' + encodeURIComponent(originalSite + pathname + query);
      res.writeHead(302, { Location: redirectUrl });
      res.end();
      return;
    }
  }

  // Alias .htm → .html for app shell files
  // (some sites or browser behaviors request .htm variant)
  if (pathname.endsWith('.htm')) {
    const htmlVariant = pathname + 'l';
    if (fs.existsSync('.' + htmlVariant)) {
      pathname = htmlVariant;
    }
  }

  // Catch-all: any path that isn't a known local file and isn't /proxy or
  // /health gets redirected through the proxy using referer (preferred) or cookie.
  const isProxyOrHealth = pathname === '/proxy' || pathname === '/health';
  const localFilePath = '.' + pathname;

  if (!isProxyOrHealth && pathname !== '/' && !fs.existsSync(localFilePath)) {
    const originToUse = extractProxyOrigin(req);

    if (originToUse) {
      const query = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      const redirectUrl = '/proxy?url=' + encodeURIComponent(originToUse + pathname + query);
      console.log('[catch-all] redirecting', pathname, '→', redirectUrl);
      res.writeHead(302, { Location: redirectUrl });
      res.end();
      return;
    }
  }

  let filePath = '.' + pathname;
  if (filePath === './') filePath = './browser.html';

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404);
      res.end('Not found');
    } else {
      res.writeHead(500);
      res.end('Server error');
    }
    return;
  }

  const headers = { 'Content-Type': contentType };
  if (filePath.endsWith('preview.html')) {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
  }

  if (stat.size > 100 * 1024) {
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

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
      res.writeHead(200, headers);
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

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err.message);
  if (
    (err.code && String(err.code).startsWith('ERR_SSL')) ||
    err.code === 'ECONNRESET' ||
    err.code === 'ECONNREFUSED'
  ) {
    return;
  }
});

async function start() {
  console.log('[puppeteer] Lazy launch enabled — Chrome starts on first SSR request');

  server.listen(PORT, () => {
    console.log(`Aika Browser running on port ${PORT}`);
  });
}

start();
