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
import { mkdtemp, mkdir, writeFile, readdir, rm, chmod } from 'node:fs/promises'
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

test('an idle live agent is drained and NOT cancelled before removal', async (t) => {
  // An idle resident Agent (a chat bridge keeps one for every session) must
  // reach quiescence on its own. Cancelling it would break a session the user
  // is merely tidying up, and if the removal later aborted the session would be
  // cancelled for nothing.
  const { apply: applyPlugin } = await import(`${packageRoot}lib/index.js`)
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
    // An idle agent returns immediately.
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
  // Drained first, released second — and never cancelled, because it was idle.
  assert.deepEqual(events.slice(0, 2), ['idle', 'parallel'])
  assert.equal(events.some(e => e.startsWith('cancel:')), false, 'an idle agent must not be cancelled')
  // Both audiences are told, ours first.
  assert.ok(events.includes('emit:session-delete/removed'), 'the plugin-owned event must fire')
  assert.ok(events.includes('emit:api-session/removed'), "DSH's UI notification must fire")
  const remaining = await readdir(bucket).catch(() => [])
  assert.deepEqual(remaining, [], 'the session directory is gone')
})

test('a wedged agent times out instead of hanging the delete forever', async (t) => {
  // The route runs inside an HTTP request the user is watching. A holder that
  // never settles must not turn "delete" into an unanswerable spinner: the wait
  // is bounded, and the removal then proceeds.
  const { apply: applyPlugin } = await import(`${packageRoot}lib/index.js`)
  const root = await mkdtemp(join(tmpdir(), 'dsd-wedged-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const SID = 'session-wedged-0001'
  const bucket = join(root, '--proj--')
  await mkdir(join(bucket, SID), { recursive: true })
  await writeFile(join(bucket, SID, 'session.v4.jsonl.zstd'), 'log')

  let handler
  const events = []
  const agent = {
    status: 'idle',
    cancel() { events.push('cancel') },
    whenIdle() { return new Promise(() => {}) },   // never settles
  }
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
  const started = Date.now()
  await handler(req, res)
  const answer = JSON.parse((await settled).body)
  const elapsed = Date.now() - started

  assert.equal(answer.ok, true, JSON.stringify(answer))
  // It gave up waiting and stopped the agent instead of blocking on it.
  assert.equal(events.includes('cancel'), true, 'a wedged agent is cancelled after the budget')
  assert.ok(elapsed < 15000, `the request must stay bounded, took ${elapsed}ms`)
  const remaining = await readdir(bucket).catch(() => [])
  assert.deepEqual(remaining, [])
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

/* ------------------------------------------------------------------ *
 * 4. Request shape and duplicate requests
 *
 * Both are about answering honestly: a malformed body is the caller's mistake
 * (400), not ours (500 with a JavaScript message), and a second request for a
 * session already being deleted must not announce a second removal.
 * ------------------------------------------------------------------ */

test('a JSON body that is not an object is a 400, never a 500', async (t) => {
  const { apply: applyPlugin } = await import(`${packageRoot}lib/index.js`)
  let handler
  const ctx = {
    logger: { info() {}, warn() {} },
    get: () => undefined,
    emit() {},
    effect(fn) { fn() },
    async parallel() {},
    inject(_names, fn) { fn(this) },
    webServer: { register(route) { handler = route.handler; return () => {} } },
  }
  applyPlugin(ctx, { sessionsRoot: await mkdtemp(join(tmpdir(), 'dsd-shape-')) })

  const call = (payload) => new Promise(resolve => {
    const res = { statusCode: 200, setHeader() {}, end(text) { resolve({ status: this.statusCode, body: text }) } }
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1:8080' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(payload) },
    }
    handler(req, res)
  })

  for (const payload of ['null', '[]', '"str"', '123', 'true']) {
    const answer = await call(payload)
    assert.equal(answer.status, 400, `${payload} must be a 400, got ${answer.status}`)
    const parsed = JSON.parse(answer.body)
    assert.equal(parsed.code, 'BAD_BODY_SHAPE')
    // No internal detail leaks: the message must not mention JavaScript errors.
    assert.equal(/Cannot read|undefined|TypeError/.test(parsed.message), false, parsed.message)
  }
})

test('two concurrent deletions of one session announce it once', async (t) => {
  // Without de-duplication both requests passed the guards, both removed, and
  // both announced — a subscriber then saw a second "removed" for an id that
  // was already gone and could not tell it from a real second deletion.
  const { apply: applyPlugin } = await import(`${packageRoot}lib/index.js`)
  const root = await mkdtemp(join(tmpdir(), 'dsd-dupdel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const SID = 'session-concurrent-0001'
  const bucket = join(root, '--proj--')
  await mkdir(join(bucket, SID), { recursive: true })
  await writeFile(join(bucket, SID, 'session.v4.jsonl.zstd'), 'log')

  const events = []
  let handler
  const ctx = {
    logger: { info() {}, warn() {} },
    get: () => undefined,
    emit(name) { events.push(name) },
    effect(fn) { fn() },
    async parallel() {},
    inject(_names, fn) { fn(this) },
    webServer: { register(route) { handler = route.handler; return () => {} } },
  }
  applyPlugin(ctx, { sessionsRoot: root })

  const call = () => new Promise(resolve => {
    const res = { statusCode: 200, setHeader() {}, end(text) { resolve({ status: this.statusCode, body: text }) } }
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1:8080' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: SID })) },
    }
    handler(req, res)
  })

  const [a, b] = await Promise.all([call(), call()])
  // Both callers get the same honest answer: it is gone.
  assert.equal(JSON.parse(a.body).ok, true)
  assert.equal(JSON.parse(b.body).ok, true)
  assert.equal(events.filter(n => n === 'session-delete/removed').length, 1, events.join(','))
  assert.equal(events.filter(n => n === 'api-session/removed').length, 1, events.join(','))
})

test('a filesystem failure answers without leaking the internal path', async (t) => {
  // The message is rendered in the confirmation dialog. An absolute path there
  // tells the user nothing actionable and exposes their directory layout, so a
  // failed removal answers in plain language instead.
  const { apply: applyPlugin } = await import(`${packageRoot}lib/index.js`)
  const root = await mkdtemp(join(tmpdir(), 'dsd-leak-'))
  t.after(() => chmod(target, 0o755).catch(() => {}))
  t.after(() => rm(root, { recursive: true, force: true }))
  const SID = 'session-unremovable-1'
  const bucket = join(root, '--proj--')
  const target = join(bucket, SID)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'session.v4.jsonl.zstd'), 'log')
  // Removing the directory's write bit makes the recursive unlink fail with
  // EACCES, which is the shape a file held by another program takes on macOS.
  await chmod(target, 0o500)

  let handler
  const ctx = {
    logger: { info() {}, warn() {} },
    get: () => undefined,
    emit() {},
    effect(fn) { fn() },
    async parallel() {},
    inject(_names, fn) { fn(this) },
    webServer: { register(route) { handler = route.handler; return () => {} } },
  }
  applyPlugin(ctx, { sessionsRoot: root })

  const answer = await new Promise(resolve => {
    const res = { statusCode: 200, setHeader() {}, end(text) { resolve({ status: this.statusCode, body: text }) } }
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1:8080' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: SID })) },
    }
    handler(req, res)
  })

  const parsed = JSON.parse(answer.body)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.code, 'DELETE_FAILED')
  // No absolute path, no raw errno token, no file name.
  assert.equal(answer.body.includes(root), false, `the message leaks the path: ${parsed.message}`)
  assert.equal(/EACCES|EPERM|unlink|ENOENT/.test(parsed.message), false, parsed.message)
  assert.match(parsed.message, /权限|出错/)
})
