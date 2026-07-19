// [460-fork] Copy the canonical user guide into the client source tree so the
// in-app Help page (src/pages/HelpPage.tsx) can import and render it. The single
// source of truth stays docs/ours-user-guide.md; this runs in `prebuild` so a
// production build always bundles the latest. Run manually after editing the
// guide if you want the dev server to pick it up immediately.
// The destination is COMMITTED, so a build only needs the copy step when the
// source is actually reachable. The Docker client stage copies `client/` alone —
// `docs/` isn't in that context — so this must no-op there rather than throw.
// (It threw for three weeks, failing every deploy silently.)
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../../docs/ours-user-guide.md')
const dest = resolve(here, '../src/content/user-guide.md')

if (!existsSync(src)) {
  if (!existsSync(dest)) {
    console.error(`[sync-guide] no guide at ${src} and no committed copy at ${dest}`)
    process.exit(1)
  }
  console.log('[sync-guide] source not in this context — using the committed copy')
} else {
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  console.log(`[sync-guide] copied ${src} -> ${dest}`)
}
