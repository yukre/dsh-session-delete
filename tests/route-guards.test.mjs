#!/usr/bin/env node
/**
 * Guards on the deletion route itself: who may call it, and what it is allowed
 * to remove.
 *
 * Two families live here, for two different reasons:
 *
 * 1. CONNECTION TRUST. The route used to accept anything that merely carried a
 *    JSON content type: a missing Origin was treated as friendly, and the
 *    cross-site comparison used the `Host` header the caller itself supplies, so
 *    forging both headers passed. Any process that could reach the loopback
 *    port could delete a session with one POST. The fence below mirrors DSH's
 *    own `isTrustedApiRequest`: Host must name a loopback authority (DNS
 *    rebinding cannot forge it), an explicit cross-site marker is refused, and
 *    an Origin — when present — must be this very authority.
 *
 * 2. WHAT THE PATH MAY POINT AT. When persistence cannot report a session's
 *    header, the directory is found by scanning buckets for a directory whose
 *    name equals the id. A name alone proves nothing: `attachments` and `.git`
 *    are legal-looking single segments and both were removed as if they were
 *    sessions. A candidate now has to look like a session directory, and an
 *    ambiguous match is refused instead of deleting the first hit.
 *
 * @module dsh-session-delete/tests/route-guards
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const packageRoot = new URL('..', import.meta.url).pathname
const { requestFence, looksLikeSessionDir, apply } = await import(
  `${packageRoot}lib/index.js`
)

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** One request stub carrying only the headers the fence reads. */
function makeReq(headers) {
  return { headers }
}

/* ------------------------------------------------------------------ *
 * 1. Connection trust
 * ------------------------------------------------------------------ */

test('a rebound Host header is refused', () => {
  const refusal = requestFence(makeReq({ host: 'evil.example' }))
  assert.ok(refusal !== undefined, 'a non-loopback Host must be refused')
})

test('a cross-site Origin is refused', () => {
  const refusal = requestFence(makeReq({
    host: '127.0.0.1:8080',
    origin: 'http://evil.example',
  }))
  assert.ok(refusal !== undefined, 'an Origin for another host must be refused')
})

test('forging BOTH Origin and Host does not pass', () => {
  // The old guard compared the two headers and accepted them when equal, so a
  // caller that supplied both got through. The Host fence is what closes it:
  // a non-loopback authority is refused no matter what Origin says.
  const refusal = requestFence(makeReq({
    host: 'evil.example',
    origin: 'http://evil.example',
  }))
  assert.ok(refusal !== undefined, 'matching forged headers must still be refused')
})

test('an explicit cross-site fetch marker is refused', () => {
  const refusal = requestFence(makeReq({
    host: '127.0.0.1:8080',
    'sec-fetch-site': 'cross-site',
  }))
  assert.ok(refusal !== undefined, 'Sec-Fetch-Site: cross-site must be refused')
})

test('an opaque origin is refused', () => {
  const refusal = requestFence(makeReq({ host: '127.0.0.1:8080', origin: 'null' }))
  assert.ok(refusal !== undefined, 'Origin: null must be refused')
})

test('the app page itself passes', () => {
  assert.equal(requestFence(makeReq({
    host: '127.0.0.1:8080',
    origin: 'http://127.0.0.1:8080',
  })), undefined)
})

test('localhost and IPv6 loopback are accepted authorities', () => {
  assert.equal(requestFence(makeReq({ host: 'localhost:8080' })), undefined)
  assert.equal(requestFence(makeReq({ host: '[::1]:8080' })), undefined)
})

/* ------------------------------------------------------------------ *
 * 2. What the path may point at
 * ------------------------------------------------------------------ */

test('a real session directory is recognised', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsd-guard-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'session-abc')
  await mkdir(dir)
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'x')
  assert.equal(await looksLikeSessionDir(dir), true)
})

test('a lock file alone is enough (a just-created session)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsd-guard-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'session-abc')
  await mkdir(dir)
  await writeFile(join(dir, 'session.lock'), '')
  assert.equal(await looksLikeSessionDir(dir), true)
})

test('an ordinary directory that merely matches the name is NOT a session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsd-guard-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  // `attachments` and `.git` are exactly the names that used to be deleted as
  // if they were sessions: a legal single segment, a real directory, no log.
  for (const name of ['attachments', '.git']) {
    const dir = join(root, name)
    await mkdir(dir)
    await writeFile(join(dir, 'some-file.txt'), 'keep me')
    assert.equal(await looksLikeSessionDir(dir), false, `${name} must not qualify`)
  }
})

test('the scan refuses to name a target when several buckets hold the id', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsd-guard-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  // Two buckets, same id, both genuine session directories. Removing the first
  // silently would destroy a copy the user may have kept on purpose.
  for (const bucket of ['--a--', '--b--']) {
    const dir = join(root, bucket, 'session-dup')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'x')
  }
  const { findSessionDir } = await import(`${packageRoot}lib/index.js`)
  const located = await findSessionDir({ get: () => undefined, logger: undefined }, root, 'session-dup')
  assert.equal(located.dir, undefined, 'an ambiguous match must not pick a winner')
  assert.equal(located.candidates.length, 2, 'both candidates are reported')
  assert.equal(located.ambiguous, true)
})

test('a bogus id is refused before the filesystem is touched', async () => {
  const { isSafeSessionId } = await import(`${packageRoot}lib/index.js`)
  for (const bad of ['../etc', 'a/b', '..', '', 'x'.repeat(200), 'a\0b']) {
    assert.equal(isSafeSessionId(bad), false, `${JSON.stringify(bad)} must be refused`)
  }
})

/* ------------------------------------------------------------------ *
 * 3. Retirement of a live holder
 *
 * A bot integration keeps a resident Agent for an idle session. Deleting the
 * directory underneath it leaves that Agent writing to a path that is gone and
 * leaves the session in the in-memory registry, which is the "ghost session"
 * state that makes an integration look broken until the next restart. Removal
 * therefore cancels and drains the holder first.
 * ------------------------------------------------------------------ */

test('a live agent is cancelled and drained before its directory is removed', async (t) => {
  const { findSessionDir: _f, apply: applyPlugin } = await import(`${packageRoot}lib/index.js`)
  const root = await mkdtemp(join(tmpdir(), 'dsd-retire-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const SID = 'session-retire-0001'
  const bucket = join(root, '--proj--')
  await mkdir(join(bucket, SID), { recursive: true })
  await writeFile(join(bucket, SID, 'session.v4.jsonl.zstd'), 'log')

  const events = []
  let handler
  const agent = {
    status: 'idle',
    cancel(cause) { events.push(`cancel:${cause.kind}`) },
    async whenIdle() { events.push('idle') },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'agents') return { get: id => (id === SID ? agent : undefined) }
      return undefined
    },
    emit(name) { events.push(`emit:${name}`) },
    effect(fn) { fn() },
    async parallel() { events.push('parallel') },
    inject(_names, fn) { fn(this) },
    webServer: { register(route) { handler = route.handler; return () => {} } },
  }
  applyPlugin(ctx, { sessionsRoot: root })

  let done
  const settled = new Promise(resolve => { done = resolve })
  const res = {
    statusCode: 200,
    setHeader() {},
    end(text) { done({ status: this.statusCode, body: text }) },
  }
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:8080' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: SID })) },
  }
  await handler(req, res)
  const answer = JSON.parse((await settled).body)

  assert.equal(answer.ok, true, JSON.stringify(answer))
  // Order matters: cancel, then drain, then release providers — all before rm.
  assert.deepEqual(events.slice(0, 3), ['cancel:disposed', 'idle', 'parallel'])
  // Both audiences are told, ours first.
  assert.ok(events.includes('emit:session-delete/removed'), 'the plugin-owned event must fire')
  assert.ok(events.includes('emit:api-session/removed'), "DSH's UI notification must fire")
  const remaining = await readdir(bucket).catch(() => [])
  assert.deepEqual(remaining, [], 'the session directory is gone')
})

test('a running agent still refuses deletion instead of cancelling work', async (t) => {
  const { apply: applyPlugin } = await import(`${packageRoot}lib/index.js`)
  const root = await mkdtemp(join(tmpdir(), 'dsd-running-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const SID = 'session-running-0001'
  const bucket = join(root, '--proj--')
  await mkdir(join(bucket, SID), { recursive: true })
  await writeFile(join(bucket, SID, 'session.v4.jsonl.zstd'), 'log')

  let handler
  let cancelled = false
  const agent = { status: 'running', cancel() { cancelled = true }, async whenIdle() {} }
  const ctx = {
    logger: { info() {}, warn() {} },
    get: name => (name === 'agents' ? { get: id => (id === SID ? agent : undefined) } : undefined),
    emit() {},
    effect(fn) { fn() },
    async parallel() {},
    inject(_names, fn) { fn(this) },
    webServer: { register(route) { handler = route.handler; return () => {} } },
  }
  applyPlugin(ctx, { sessionsRoot: root })

  let done
  const settled = new Promise(resolve => { done = resolve })
  const res = { statusCode: 200, setHeader() {}, end(text) { done({ status: this.statusCode, body: text }) } }
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:8080' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: SID })) },
  }
  await handler(req, res)
  const answer = JSON.parse((await settled).body)

  // The user's constraint: never interrupt running work. Refuse, leave it alone.
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'SESSION_RUNNING')
  assert.equal(cancelled, false, 'a running agent must not be cancelled')
  const remaining = await readdir(bucket).catch(() => [])
  assert.deepEqual(remaining, [SID], 'the running session is untouched')
})

test('the bucket scan skips a directory that only shares the name', async (t) => {
  // Guards the CALL SITE, not just the predicate: an ordinary directory whose
  // name happens to be a legal session id must never be returned as a target.
  // Without the check inside the scan, `attachments` and `.git` were deleted as
  // if they held a session log.
  const root = await mkdtemp(join(tmpdir(), 'dsd-scan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['attachments', '.git', 'session-real']) {
    const dir = join(root, '--proj--', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'keep.txt'), 'x')
  }
  // Give only the third one a real log.
  await writeFile(join(root, '--proj--', 'session-real', 'session.v4.jsonl.zstd'), 'log')

  const { findSessionDir } = await import(`${packageRoot}lib/index.js`)
  const ctx = { get: () => undefined, logger: undefined }

  for (const name of ['attachments', '.git']) {
    const located = await findSessionDir(ctx, root, name)
    assert.equal(located.dir, undefined, `${name} must never be returned as a target`)
    assert.equal(located.ambiguous, false)
  }
  const real = await findSessionDir(ctx, root, 'session-real')
  assert.ok(real.dir !== undefined, 'a genuine session directory is still found')
  assert.equal(real.dir.endsWith('session-real'), true)
})
