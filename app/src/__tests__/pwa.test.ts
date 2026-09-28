import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * PWA shell assertions. These run at unit-test time (against `public/`)
 * rather than in a browser, so they're a guardrail against accidentally
 * dropping the manifest, the icon, or the iOS meta tags that the
 * "Add to Home Screen" flow needs.
 */
describe('PWA shell', () => {
  const publicDir = path.join(__dirname, '..', '..', 'public');
  const indexPath = path.join(__dirname, '..', '..', 'index.html');

  it('ships a manifest.webmanifest', () => {
    const manifestPath = path.join(publicDir, 'manifest.webmanifest');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const m = JSON.parse(raw);
    expect(m.name).toBeTruthy();
    expect(m.short_name).toBeTruthy();
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
    expect(m.display).toBe('standalone');
    expect(Array.isArray(m.icons)).toBe(true);
    expect(m.icons.length).toBeGreaterThan(0);
    expect(m.icons[0].src).toBeTruthy();
    // The referenced icon must actually be in public/ — broken icon paths
    // would silently break the "Add to Home Screen" install on Android.
    const iconSrc = m.icons[0].src.replace(/^\//, '');
    expect(fs.existsSync(path.join(publicDir, iconSrc))).toBe(true);
  });

  it('ships the icon referenced by the manifest', () => {
    const iconPath = path.join(publicDir, 'icon.svg');
    expect(fs.existsSync(iconPath)).toBe(true);
    const svg = fs.readFileSync(iconPath, 'utf8');
    expect(svg).toMatch(/^<svg/);
  });

  it('index.html links the manifest and iOS Add-to-Home-Screen tags', () => {
    const html = fs.readFileSync(indexPath, 'utf8');
    expect(html).toMatch(/<link[^>]+rel=["']manifest["'][^>]+href=["']\/manifest\.webmanifest["']/);
    // iOS Safari ignores <link rel="manifest"> and relies on these tags
    // instead — both are required for the home-screen icon to render and
    // for the page to launch in standalone mode.
    expect(html).toMatch(/<meta[^>]+name=["']apple-mobile-web-app-capable["']/);
    expect(html).toMatch(/<meta[^>]+name=["']apple-mobile-web-app-title["']/);
    expect(html).toMatch(/<link[^>]+rel=["']apple-touch-icon["']/);
    expect(html).toMatch(/<meta[^>]+name=["']theme-color["']/);
  });

  it('service worker still references the bundled icon path', () => {
    const swPath = path.join(publicDir, 'sw.js');
    expect(fs.existsSync(swPath)).toBe(true);
    const sw = fs.readFileSync(swPath, 'utf8');
    // Stale icon paths (e.g. /icon-192.png from before the SVG migration)
    // would render as broken notifications — keep the icon name in sync
    // with public/icon.svg.
    expect(sw).toContain('/icon.svg');
  });
});