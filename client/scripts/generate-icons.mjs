/**
 * Generates PNG icons for PWA from the master SVG icon.
 * Run: node scripts/generate-icons.mjs
 * Called automatically via the "prebuild" npm script.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, '..', 'public', 'icons');
const svgBuffer = readFileSync(join(iconsDir, 'icon.svg'));
const maskableSvgBuffer = readFileSync(join(iconsDir, 'icon-maskable.svg'));

// Regular icons \u2014 full design (sun, 460, TRIP PLANNER subtitle, landscape).
// Used by browsers as the favicon/header icon and by iOS as the home-screen icon.
const sizes = [
  { name: 'apple-touch-icon-180x180.png', size: 180 },
  { name: 'icon-192x192.png', size: 192 },
  { name: 'icon-512x512.png', size: 512 },
];

for (const { name, size } of sizes) {
  await sharp(svgBuffer, { density: 300 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(join(iconsDir, name));
  console.log(`  \u2713 ${name} (${size}x${size})`);
}

// Maskable icon \u2014 simplified design with content inside the inner 80% safe
// zone, background filling to the edges. Required for Android adaptive icons
// to render correctly without the launcher cropping our text or falling back
// to a grey placeholder.
await sharp(maskableSvgBuffer, { density: 300 })
  .resize(512, 512)
  .png({ compressionLevel: 9 })
  .toFile(join(iconsDir, 'icon-512x512-maskable.png'));
console.log('  \u2713 icon-512x512-maskable.png (512x512, maskable)');

console.log('PWA icons generated.');
