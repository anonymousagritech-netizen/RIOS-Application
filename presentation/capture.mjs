import { chromium } from '/home/user/RIOS-Application/e2e/node_modules/playwright/index.mjs';
import { existsSync } from 'node:fs';
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome','/opt/pw-browsers/chromium/chrome-linux/chrome'].find(existsSync);
const OUT = '/home/user/RIOS-Application/presentation/assets/screens';
const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1680, height: 1040 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto('http://localhost:5173/');
await p.locator('input[type="email"]').first().fill('admin@demo.rios');
await p.locator('input[type="password"]').first().fill('demo1234');
const t = p.locator('input[name="tenantCode"]').first(); if (await t.count()) await t.fill('demo');
await p.getByRole('button', { name: /sign in/i }).first().click();
await p.waitForTimeout(3000);

const shots = [
  ['dashboard', '/dashboard'],
  ['executive', '/executive'],
  ['ai-insights', '/ai-insights'],
  ['underwriting', '/w/underwriting'],
  ['treaty', '/w/treaty'],
  ['facultative', '/w/facultative'],
  ['capacity-exposure', '/w/capacity-exposure'],
  ['territory', '/w/territory'],
  ['pricing', '/pricing'],
  ['parties', '/parties'],
  ['crm', '/crm'],
  ['claims', '/claims'],
  ['workflow-engine', '/workflow-engine'],
  ['accounting', '/accounting'],
  ['finance', '/finance'],
  ['analytics', '/analytics'],
  ['risk-capital', '/risk-capital'],
  ['compliance', '/compliance'],
  ['reports', '/reports'],
  ['attendance', '/attendance'],
  ['documents', '/documents'],
  ['integration-hub', '/integration-hub'],
  ['products', '/products'],
  ['search', '/search'],
  ['admin', '/admin'],
];
for (const [name, route] of shots) {
  try {
    await p.goto('http://localhost:5173' + route, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1600);
    await p.screenshot({ path: `${OUT}/${name}.png` });
    console.log('shot', name);
  } catch (e) { console.log('FAIL', name, e.message.split('\n')[0]); }
}
await b.close();
console.log('done');
