import fs from 'fs';
import puppeteer from 'puppeteer-core';
import config from './config.js';

let browser = null;
let browserPromise = null;

function findChromiumExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    config.PUPPETEER_EXECUTABLE_PATH,
    '/data/data/com.termux/files/usr/bin/chromium-browser',
    '/data/data/com.termux/files/usr/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

export async function getRenderBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (browserPromise) return browserPromise;

  browserPromise = (async () => {
    const executablePath = findChromiumExecutable();
    if (!executablePath) {
      throw new Error(
        'Chromium was not found. Install Termux chromium and set PUPPETEER_EXECUTABLE_PATH in .env to its full path.',
      );
    }

    const launched = await puppeteer.launch({
      executablePath,
      headless: true,
      defaultViewport: { width: 800, height: 800, deviceScaleFactor: 1 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-background-networking',
        '--disable-extensions',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    browser = launched;
    launched.once('disconnected', () => {
      if (browser === launched) browser = null;
    });
    return launched;
  })().finally(() => {
    browserPromise = null;
  });

  return browserPromise;
}

export async function closeRenderBrowser() {
  const current = browser;
  browser = null;
  if (current?.isConnected()) await current.close();
}

export default { getRenderBrowser, closeRenderBrowser };
