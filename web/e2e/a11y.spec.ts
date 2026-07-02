import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PAGES = [
  { name: 'login', path: '/login' },
  { name: 'dashboard', path: '/dashboard' },
  { name: 'treaties', path: '/treaties' },
  { name: 'claims', path: '/claims' },
  { name: 'statements', path: '/statements' },
  { name: 'finance', path: '/finance' },
];

test.describe('Accessibility audit', () => {
  for (const page of PAGES) {
    test(`${page.name} has no critical or serious violations`, async ({ page: browserPage }) => {
      await browserPage.goto(page.path);
      // Wait for the page to load
      await browserPage.waitForLoadState('networkidle');

      const results = await new AxeBuilder({ page: browserPage })
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();

      const criticalOrSerious = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      );

      if (criticalOrSerious.length > 0) {
        console.log('A11y violations found:');
        criticalOrSerious.forEach((v) => {
          console.log(`  [${v.impact}] ${v.id}: ${v.description}`);
          v.nodes.slice(0, 2).forEach((n) => console.log(`    Node: ${n.html}`));
        });
      }

      expect(
        criticalOrSerious,
        `Found ${criticalOrSerious.length} critical/serious a11y violations on ${page.name}`,
      ).toHaveLength(0);
    });
  }
});
