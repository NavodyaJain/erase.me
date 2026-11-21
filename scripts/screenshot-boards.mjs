// Screenshots every design board in docs/design/source into docs/design/screens.
// Needs Playwright with a Chromium build available. It is NOT a repo dependency (large download):
//   npx -y -p playwright node scripts/screenshot-boards.mjs   (after `npx playwright install chromium`)
// Boards load Inter from Google Fonts, so it needs network access.
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'docs/design/source');
const OUT = path.join(ROOT, 'docs/design/screens');
fs.mkdirSync(OUT, { recursive: true });

const canvas = JSON.parse(fs.readFileSync(path.join(SRC, 'canvas.json'), 'utf8'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const server = http
  .createServer((req, res) => {
    const file = path.join(SRC, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(SRC)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(0);
const { port } = server.address();

const slug = (t) => t.toLowerCase().replace(/·/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const browser = await chromium.launch();
for (const board of canvas.artboards) {
  const phone = board.w === 390; // phone boards 390x844, everything else 1440 wide
  const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/${board.file}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  const name = `${slug(board.title).replace(/^(\d)-/, '0$1-')}.png`;
  await page.screenshot({ path: path.join(OUT, name), fullPage: true });
  console.log(name);
  await ctx.close();
}
await browser.close();
server.close();
