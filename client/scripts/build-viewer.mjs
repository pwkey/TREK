// [460-fork] Milestone 7 slice 5 — build the standalone offline viewer.
//
// Reads client/src/viewer/viewer.template.html and inlines jszip's
// minified source so the output is a single self-contained .html file
// that works offline without any other assets.
//
// Output: client/public/viewer.html (served at /viewer.html in dev,
// included in production builds, and bundled into export zips by the
// server's exportService — see slice 7.5 part 2).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = dirname(here);
const templatePath = join(clientRoot, 'src/viewer/viewer.template.html');
const jszipPath = join(clientRoot, 'node_modules/jszip/dist/jszip.min.js');
const outPath = join(clientRoot, 'public/viewer.html');

const template = readFileSync(templatePath, 'utf8');
const jszipSrc = readFileSync(jszipPath, 'utf8');

// Inline jszip inside a script tag where the template marks the slot.
const inlinedScript = `<script>\n/* jszip inlined */\n${jszipSrc}\n</script>`;
const out = template.replace('<!-- INLINED_JSZIP -->', inlinedScript);

if (out === template) {
  throw new Error('build-viewer.mjs: <!-- INLINED_JSZIP --> placeholder not found in template');
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out, 'utf8');
console.log(`[viewer] built ${outPath} (${(out.length / 1024).toFixed(1)} KB)`);
