#!/usr/bin/env node
/**
 * Preserve Cindy's release artwork pixel-for-pixel and add a game-style Beta
 * corner banner that remains distinguishable at Windows taskbar sizes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resourcesDir = path.join(__dirname, '..', 'resources');
const sourcePath = process.argv[2] ?? path.join(resourcesDir, 'icon-master-1024.png');
const outPath = process.argv[3] ?? path.join(resourcesDir, 'icon-beta-master-1024.png');

const badge = Buffer.from(`
  <svg width="1024" height="1024" viewBox="0 0 1024 1024">
    <defs>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
        <feDropShadow dx="0" dy="14" stdDeviation="12" flood-color="#000" flood-opacity="0.72"/>
      </filter>
    </defs>
    <g filter="url(#shadow)">
      <path d="M492 0H1024V330L914 408L492 104Z" fill="#161827"/>
      <path d="M544 0H1024V276L916 352L544 84Z" fill="#F04438"/>
      <path d="M584 0H1024V40H610Z" fill="#FFD84D"/>
      <path d="M969 0H1024V294L969 333Z" fill="#FFD84D"/>
      <text x="782" y="184" transform="rotate(35 782 184)"
        text-anchor="middle" dominant-baseline="middle"
        font-family="Arial, Helvetica, sans-serif" font-size="166" font-weight="900"
        letter-spacing="-8" fill="#FFFFFF" stroke="#11131E" stroke-width="13"
        paint-order="stroke fill">BETA</text>
    </g>
  </svg>`);

async function main() {
  if (!fs.existsSync(sourcePath)) throw new Error(`source icon missing: ${sourcePath}`);
  await sharp(sourcePath)
    .resize(1024, 1024, { fit: 'cover' })
    .ensureAlpha()
    .composite([{ input: badge }])
    .png()
    .toFile(outPath);
  console.log(`[generate-beta-icon-master] wrote ${outPath}`);
}

main().catch((error) => {
  console.error('[generate-beta-icon-master] failed:', error);
  process.exit(1);
});
