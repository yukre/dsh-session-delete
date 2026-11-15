#!/usr/bin/env node
/**
 * Verify that a packed install carries everything the code imports.
 *
 * Why this exists: a linked (`link:`) install points at the whole checkout, so a
 * module missing from `files` still loads. Only a packed tarball — what a Git or
 * npm install actually gets — can reveal the gap, and it surfaces as a crash at
 * startup ("failed to import: ERR_MODULE_NOT_FOUND") rather than at build time.
 *
 * The check walks every relative import in lib/, resolves it against the file
 * set npm would pack, and fails when an imported module is not in that set. It
 * needs no network and no install.
 *
 * @module dsh-session-delete/tests/pack-contents
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every module specifier imported by the files under `lib/`.
 * Only relative imports matter here: a bare specifier is a dependency declared in
 * `package.json`, which npm always installs.
 * @returns pairs of { importer, specifier }.
 */
function relativeImports() {
  const libDir = join(packageRoot, 'lib')
  if (!existsSync(libDir)) return []
  const found = []
  for (const name of readdirSync(libDir)) {
    if (!name.endsWith('.js')) continue
    const file = join(libDir, name)
    const source = readFileSync(file, 'utf8')
    // Static imports/`export ... from`, plus a dynamic import() of a literal.
    const pattern = /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g
    let match
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1] ?? match[2]
      if (specifier !== undefined) found.push({ importer: name, specifier })
    }
  }
  return found
}

/**
 * The exact file list `npm pack` would produce.
 * @returns relative paths.
 */
function packedFiles() {
  // `--dry-run` builds the manifest without writing a tarball.
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: packageRoot,
    encoding: 'utf8',
    // npm prints notices on stderr; the JSON is on stdout.
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const parsed = JSON.parse(raw)
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  return (entry?.files ?? []).map(file => file.path)
}

test('every module lib/ imports is inside the packed tarball', () => {
  const packed = new Set(packedFiles())
  assert.ok(packed.size > 0, 'npm pack reported no files at all')

  // No relative imports is a legitimate shape (a single-file plugin), so this
  // must not fail; it only means there is nothing to cross-check.
  const imports = relativeImports()

  const missing = []
  for (const { importer, specifier } of imports) {
    // Resolve as the runtime would: relative to the importing module.
    const target = relative(packageRoot, resolve(packageRoot, 'lib', specifier))
    if (!packed.has(target)) missing.push(`lib/${importer} imports ${specifier} → ${target} is NOT packed`)
  }
  assert.deepEqual(missing, [], `packed install would fail to import:\n${missing.join('\n')}`)
})

test('the packed tarball carries the entry points and the patch', () => {
  const packed = new Set(packedFiles())
  // These are the files a bundle cannot function without; a rename that drops one
  // is as fatal as a missing module, so they are asserted by name.
  for (const required of ['package.json', 'lib/index.js', 'cordis.patch.yml']) {
    assert.equal(packed.has(required), true, `${required} must be packed`)
  }
  // The client half is optional at the manifest level but required by this bundle.
  assert.equal(packed.has('lib/client.js'), true, 'lib/client.js must be packed')
})

test('the manifest names directories rather than individual modules', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const files = manifest.files ?? []
  // Listing `lib/index.js` + `lib/client.js` by name is what let later modules
  // fall outside the tarball. Naming the directory makes that impossible.
  assert.equal(
    files.includes('lib'),
    true,
    `files must include the "lib" directory, got ${JSON.stringify(files)}`,
  )
})
