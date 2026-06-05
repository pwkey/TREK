// [460-fork] Typecheck ratchet.
//
// The client tree has a large backlog of pre-existing TypeScript errors (the
// build uses esbuild via Vite, which never type-checks, and CI historically had
// no `tsc` gate). Fixing all of them at once is a refactor we don't want; but we
// DO want new work to be type-checked. This script is the ratchet: it runs
// `tsc --noEmit`, normalises the errors (dropping line/column so the baseline is
// stable against unrelated line shifts), and compares the result against a
// committed baseline (tsc-baseline.json).
//
//   node scripts/typecheck-baseline.mjs            # check: fail (exit 1) on NEW errors
//   node scripts/typecheck-baseline.mjs --update   # regenerate the baseline
//
// "New" means an error signature (file + TS code + message) that appears more
// often than the baseline records. Improvements never fail the check — when the
// count drops, it nudges you to run --update to ratchet the baseline down.

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = path.join(projectRoot, 'tsc-baseline.json')
const update = process.argv.includes('--update')

// Run the locally-installed tsc through node so this works identically on
// Windows and the Linux CI runner (no reliance on shell / .bin resolution).
const tscBin = require.resolve('typescript/bin/tsc')
const res = spawnSync(process.execPath, [tscBin, '--noEmit'], {
  cwd: projectRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
const output = `${res.stdout || ''}${res.stderr || ''}`

// Primary error lines look like:  src/foo.tsx(12,34): error TS2339: Message...
// Indented continuation lines (the "Types of property ..." detail) are ignored;
// we key on the primary line only.
const ERROR_RE = /^(.+?)\((\d+),(\d+)\): (error TS\d+: .*)$/
const counts = Object.create(null)
let total = 0
for (const rawLine of output.split(/\r?\n/)) {
  const m = ERROR_RE.exec(rawLine)
  if (!m) continue
  const file = m[1].replace(/\\/g, '/') // normalise Windows backslashes
  const key = `${file}: ${m[4]}`
  counts[key] = (counts[key] || 0) + 1
  total += 1
}

const sortedCounts = Object.fromEntries(Object.keys(counts).sort().map(k => [k, counts[k]]))

if (update) {
  const payload = {
    note: 'Baseline of pre-existing tsc --noEmit errors. Regenerate with `npm run typecheck:update`. Lower is better; never raise it to silence new errors.',
    total,
    errors: sortedCounts,
  }
  writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`✓ Baseline written: ${total} error(s) across ${Object.keys(sortedCounts).length} signature(s).`)
  process.exit(0)
}

if (!existsSync(baselinePath)) {
  console.error('✗ No tsc-baseline.json found. Generate it with: npm run typecheck:update')
  process.exit(1)
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
const baseErrors = baseline.errors || {}

// New = signatures whose current count exceeds the baseline count.
const newErrors = []
for (const [key, count] of Object.entries(counts)) {
  const allowed = baseErrors[key] || 0
  if (count > allowed) newErrors.push({ key, count, allowed })
}

if (newErrors.length > 0) {
  console.error(`✗ ${newErrors.length} new type error signature(s) introduced (not in baseline):\n`)
  for (const e of newErrors.sort((a, b) => a.key.localeCompare(b.key))) {
    const extra = e.allowed > 0 ? ` (baseline allows ${e.allowed}, found ${e.count})` : ''
    console.error(`  ${e.key}${extra}`)
  }
  console.error(`\nFix the error(s) above. If a change INTENTIONALLY alters the type surface,`)
  console.error(`regenerate the baseline with: npm run typecheck:update`)
  process.exit(1)
}

if (total < (baseline.total || 0)) {
  console.log(`✓ No new type errors. Errors dropped ${baseline.total} → ${total} — run \`npm run typecheck:update\` to ratchet the baseline down.`)
} else {
  console.log(`✓ No new type errors (${total} pre-existing, matching baseline).`)
}
process.exit(0)
