import { execSync } from 'node:child_process';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const PUPPETEER_ENABLED = process.env.PUPPETEER_ENABLED !== 'false';

let renderQueue = Promise.resolve();

// In-flight render promises keyed by URL
const inFlightRenders = new Map();

let idleShutdownTimer = null;
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;

function scheduleIdleShutdown() {
  if (!PUPPETEER_ENABLED) return;
  clearTimeout(idleShutdownTimer);
  idleShutdownTimer = setTimeout(async () => {
    if (browser?.isConnected()) {
      console.log('[puppeteer] Idle shutdown — closing browser to free memory');
      await browser.close().catch(() => {});
      browser = null;
    }
  }, IDLE_SHUTDOWN_MS);
}

function cancelIdleShutdown() {
  clearTimeout(idleShutdownTimer);
}

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-translate',
  '--metrics-recording-only',
  '--mute-audio',
  '--safebrowsing-disable-auto-update',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--js-flags=--max-old-space-size=256',
];

const NAV_TIMEOUT_MS = 8_000;
const VIDEO_WAIT_MS = 5_000;
const PLAYER_DOMAINS = ['mp4upload.com', 'streamtape.com'];

function getNavTimeout(url) {
  try {
    const host = new URL(url).hostname;
    if (PLAYER_DOMAINS.some((d) => host.includes(d))) return 15_000;
  } catch {
    /* ignore */
  }
  return NAV_TIMEOUT_MS;
}

function isPlayerDomainUrl(url) {
  return PLAYER_DOMAINS.some((d) => url.includes(d));
}

const ALLOWED_RESOURCE_TYPES = new Set([
  'document',
  'script',
  'xhr',
  'fetch',
  'websocket',
]);

let browser = null;
let browserLaunching = null;
let lastLaunchError = null;
let lastLaunchAt = null;
let relaunchScheduled = false;

export let activeRenders = 0;
const MAX_CONCURRENT_RENDERS = 1;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
];

function pickUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function findNixStoreChromium() {
  try {
    const nixChromium = execSync(
      'find /nix/store -name "chromium" -type f 2>/dev/null | head -1',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    )
      .toString()
      .trim();
    return nixChromium || null;
  } catch {
    return null;
  }
}

function findChromiumPath() {
  const paths = [];

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    paths.push(process.env.PUPPETEER_EXECUTABLE_PATH);
  }

  const nixChromium = findNixStoreChromium();
  if (nixChromium) paths.push(nixChromium);

  paths.push(
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome'
  );

  if (process.platform === 'win32') {
    paths.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    );
  }

  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }

  const whichCmds =
    process.platform === 'win32'
      ? ['where chromium', 'where chromium-browser', 'where chrome']
      : ['which chromium', 'which chromium-browser', 'which google-chrome'];

  for (const cmd of whichCmds) {
    try {
      const out = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
        .trim()
        .split(/\r?\n/)[0]
        ?.trim();
      if (out && fs.existsSync(out)) return out;
    } catch {
      /* not found */
    }
  }

  return null;
}

const STEALTH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const AGE_GATE_COOKIES = {
  'xvideos.com': 'platform=pc; age_verified=1',
  'xnxx.com': 'platform=pc; age_verified=1',
  'xhamster.com': 'age_confirmed=1; platform=desktop',
  'eporner.com': 'verified_age=1',
  'redtube.com': 'age_verified=1',
  'youporn.com': 'age_verified=1',
  'tube8.com': 'age_verified=1',
  'pornhub.com': 'age_verified=1',
  'jav.guru': 'ageGate=true',
  'youjizz.com': 'age_verified=1; __age=verified',
};

function getAgeGateCookies(targetUrl) {
  try {
    const host = new URL(targetUrl).hostname.replace(/^www\./, '');
    for (const [domain, cookies] of Object.entries(AGE_GATE_COOKIES)) {
      if (host.includes(domain)) return cookies;
    }
  } catch {
    /* ignore */
  }
  return '';
}

function buildPageHeaders(req, targetUrl) {
  const headers = {
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };

  const cookies = [req?.headers?.cookie, getAgeGateCookies(targetUrl)].filter(Boolean).join('; ');
  if (cookies) {
    headers.Cookie = cookies;
  }

  return headers;
}

function scheduleRelaunch() {
  if (!PUPPETEER_ENABLED) return;
  if (relaunchScheduled) return;
  relaunchScheduled = true;
  browser = null;
  setTimeout(() => {
    relaunchScheduled = false;
    initPuppeteerBrowser().catch((err) => {
      console.error('[puppeteer] Relaunch failed:', err.message);
    });
  }, 500);
}

function attachBrowserHandlers(instance) {
  instance.on('disconnected', () => {
    console.warn('[puppeteer] Browser disconnected');
    browser = null;
    scheduleRelaunch();
  });
}

async function launchBrowser() {
  const executablePath = findChromiumPath();
  if (!executablePath) {
    throw new Error(
      'Chromium executable not found (set PUPPETEER_EXECUTABLE_PATH or install chromium)'
    );
  }

  const instance = await puppeteer.launch({
    executablePath,
    headless: true,
    args: LAUNCH_ARGS,
    ignoreHTTPSErrors: true,
  });

  attachBrowserHandlers(instance);
  browser = instance;
  lastLaunchError = null;
  lastLaunchAt = new Date().toISOString();
  console.log(`[puppeteer] Browser launched (${executablePath})`);
  return instance;
}

export async function initPuppeteerBrowser() {
  if (!PUPPETEER_ENABLED) {
    console.log('[puppeteer] Disabled via PUPPETEER_ENABLED=false');
    return null;
  }
  if (browser?.isConnected()) return browser;
  if (browserLaunching) return browserLaunching;

  browserLaunching = launchBrowser()
    .catch((err) => {
      lastLaunchError = err.message;
      browser = null;
      throw err;
    })
    .finally(() => {
      browserLaunching = null;
    });

  return browserLaunching;
}

export async function getBrowser() {
  if (!PUPPETEER_ENABLED) return null;
  if (browser?.isConnected()) return browser;
  return initPuppeteerBrowser();
}

export function getPuppeteerHealth() {
  if (!PUPPETEER_ENABLED) {
    return { enabled: false, connected: false };
  }
  return {
    enabled: true,
    connected: browser?.isConnected() ?? false,
    launching: Boolean(browserLaunching),
    chromiumPath: findChromiumPath(),
    lastLaunchAt,
    lastLaunchError,
  };
}

export async function closePuppeteerBrowser() {
  if (!browser) return;
  try {
    await browser.close();
  } catch (err) {
    console.warn('[puppeteer] close error:', err.message);
  }
  browser = null;
}

/**
 * Render a URL to fully-hydrated HTML via headless Chromium.
 * @throws on navigation/render failure (caller should fall back to fetch)
 */
export async function renderHtmlWithPuppeteer(targetUrl, req, signal) {
  if (!PUPPETEER_ENABLED) throw new Error('Puppeteer disabled');
  if (inFlightRenders.has(targetUrl)) {
    console.log('[puppeteer] Coalescing duplicate render for:', targetUrl.slice(0, 80));
    return inFlightRenders.get(targetUrl);
  }

  const run = () => renderHtmlWithPuppeteerInner(targetUrl, req, signal);
  const queued = renderQueue.then(run, run);
  renderQueue = queued.catch(() => {});

  const tracked = queued.finally(() => {
    inFlightRenders.delete(targetUrl);
  });
  inFlightRenders.set(targetUrl, tracked);

  return tracked;
}

async function renderHtmlWithPuppeteerInner(targetUrl, req, signal) {
  cancelIdleShutdown();
  activeRenders++;

  try {
    const instance = await getBrowser();
    const page = await instance.newPage();

    if (signal) {
      signal.addEventListener('abort', () => {
        page.close().catch(() => {});
      });
    }

    try {
      await page.setUserAgent(STEALTH_USER_AGENT);
      await page.setExtraHTTPHeaders(buildPageHeaders(req, targetUrl));
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        window.chrome = { runtime: {} };
      });
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const type = request.resourceType();
        const url = request.url();
        if (isPlayerDomainUrl(url) || ALLOWED_RESOURCE_TYPES.has(type)) {
          request.continue();
        } else {
          request.abort();
        }
      });

      const navTimeout = getNavTimeout(targetUrl);
      const renderTimeout = isPlayerDomainUrl(targetUrl) ? 28_000 : navTimeout + VIDEO_WAIT_MS + 5_000;

      const html = await Promise.race([
        (async () => {
          await page.goto(targetUrl, {
            waitUntil: isPlayerDomainUrl(targetUrl) ? 'networkidle2' : 'domcontentloaded',
            timeout: navTimeout,
          });

          if (isPlayerDomainUrl(targetUrl)) {
            await page
              .waitForSelector('#app:not(:empty), video, .player', { timeout: 10_000 })
              .catch(() => {});
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            await page.waitForSelector('video', { timeout: VIDEO_WAIT_MS }).catch(() => {});
          }

          return await page.content();
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Puppeteer render timed out')), renderTimeout)
        ),
      ]);

      if (isPlayerDomainUrl(targetUrl) && html.length < 5_000) {
        throw new Error('Puppeteer returned player shell without hydrated content');
      }

      return html;
    } finally {
      await page.close().catch(() => {});
      scheduleIdleShutdown();
    }
  } finally {
    activeRenders--;
  }
}
