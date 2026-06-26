// [460-fork] Copy the canonical user guide into the client source tree so the
// in-app Help page (src/pages/HelpPage.tsx) can import and render it. The single
// source of truth stays docs/ours-user-guide.md; this runs in `prebuild` so a
// production build always bundles the latest. Run manually after editing the
// guide if you want the dev server to pick it up immediately.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../../docs/ours-user-guide.md')
const dest = resolve(here, '../src/content/user-guide.md')
mkdirSync(dirname(dest), { recursive: true })
copyFileSync(src, dest)
console.log(`[sync-guide] copied ${src} -> ${dest}`)
