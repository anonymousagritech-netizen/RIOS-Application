import { lazy, type ComponentType } from 'react';

/**
 * Route-level code splitting for pages with NAMED exports (perf finding D-4).
 *
 * Pages export `export function XPage() { … }` rather than a default export,
 * so we map the named export onto the `{ default }` shape `React.lazy`
 * expects. Each page then becomes its own chunk, fetched on first navigation.
 *
 *   const DashboardPage = lazyPage(() => import('../pages/DashboardPage'), 'DashboardPage');
 */
export function lazyPage<K extends string, M extends Record<K, ComponentType>>(
  loader: () => Promise<M>,
  name: K,
) {
  return lazy(() => loader().then((m) => ({ default: m[name] })));
}
