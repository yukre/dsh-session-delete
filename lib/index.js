/**
 * dsh-session-delete — Host half.
 *
 * Adds a "Delete session" operation that DSH itself does not provide: DSH's
 * built-in Archive only writes a hide-marker into the workspace registry and
 * keeps every log byte, while `SessionPersistence` deliberately exposes no
 * delete (create/open/flush/stat/list only). This plugin therefore performs a
 * real, irreversible removal of ONE session's on-disk artifact directory.
 *
 * Division of labour with Archive (kept strictly separate by design):
 *   - Archive  = hide + keep data  (built-in, reversible)
 *   - Delete   = purge data        (this plugin, irreversible)
 *
 * Storage layout this relies on (verified against this installation):
 *   ~/.dsh/sessions/<encoded-cwd>/<sessionId>/
 *     session.v4.jsonl.zstd   the session log
 *     session.lock            POSIX flock file; readers never touch it and the
 *                             directory may be removed freely while unlocked
 * A session is listed by scanning this directory tree, so removing the
 * directory removes the session from every list without a second index.
 *
 * Transport: a same-origin HTTP route whose handler runs in the Host process.
 * The Client half calls it with fetch(). The route only ever removes a
 * directory that resolves INSIDE the configured session root, so a crafted
 * request cannot escape it.
 *
 * @module dsh-session-delete
 */

import { rm, rmdir, stat, readdir } from 'node:fs/promises'
import { join, resolve, sep, dirname } from 'node:path'

/** Response shape returned to the Client half. */
/**
 * @typedef {{ ok: true, sessionId: string, removed: string }} DeleteOk
 * @typedef {{ ok: false, code: string, message: string }} DeleteFail
 */

/**
 * Guard: refuse anything that is not a well-formed session id.
 * Session ids look like `session-<uuid>` or a bare `<uuid>`; this rejects any
 * path separator, `..`, or absolute path before it reaches the filesystem.
 * @param value - candidate id from the request body.
 * @returns true when the id is a single safe path segment.
 */
export function isSafeSessionId(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 128) return false
  // One path segment only: no separators, no traversal, no NUL.
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) return false
  if (value === '.' || value === '..') return false
  return /^[A-Za-z0-9._-]+$/.test(value)
}

/**
 * Resolve the directory a session id names, and prove it stays inside the
 * session root. Returns undefined when it escapes.
 * @param sessionRoot - absolute configured sessions directory.
 * @param cwdKey - encoded workspace directory name holding the session.
 * @param sessionId - validated session id.
 * @returns the absolute session directory, or undefined when out of bounds.
 */
export function resolveSessionDir(sessionRoot, cwdKey, sessionId) {
  const root = resolve(sessionRoot)
  const dir = resolve(root, cwdKey, sessionId)
  if (dir !== root && !dir.startsWith(root + sep)) return undefined
  return dir
}

/** Read a capped JSON request body. */
async function readJsonBody(req, maxBytes = 16 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Write one JSON response. */
function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}

/**
 * Same-origin guard.
 *
 * A browser fetch from the app's own page normally carries `Origin`; an
 * Electron renderer hitting its own origin may omit it entirely, so a missing
 * header is NOT treated as hostile. What must never pass is a request whose
 * `Origin` is present AND names a different host: that is the cross-site case
 * the guard exists for. A JSON content type stays required, because a
 * cross-site form cannot set one.
 */
function sameOriginViolation(req) {
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json') return '请求必须是 application/json 类型'
  const origin = String(req.headers.origin ?? '')
  if (origin === '') return null
  const host = String(req.headers.host ?? '')
  let originHost
  try {
    originHost = new URL(origin).host
  } catch {
    return 'Origin 请求头格式不正确'
  }
  if (host !== '' && originHost !== host) return '已拒绝跨站请求'
  return null
}

/**
 * Locate every session directory for an id. The Client never tells us which
 * workspace bucket holds the session, and the same id can legitimately appear
 * under more than one bucket (a moved workspace, a copied profile). Returning
 * ALL matches matters: removing only the first would leave a duplicate behind
 * that still lists as a live session — a ghost the user cannot explain.
 * @param sessionRoot - absolute sessions root.
 * @param sessionId - validated id.
 * @returns every absolute directory holding this id, possibly empty.
 */
async function findSessionDirs(sessionRoot, sessionId) {
  const root = resolve(sessionRoot)
  let buckets
  try {
    buckets = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const found = []
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const candidate = resolveSessionDir(root, bucket.name, sessionId)
    if (candidate === undefined) continue
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) found.push(candidate)
    } catch {
      // not in this bucket
    }
  }
  return found
}

/**
 * Refuse to delete a session whose Agent is actively RUNNING a turn.
 *
 * Only `running` is refused. A merely-idle live Agent is NOT a refusal: many
 * integrations (a chat bot, for example) keep a resident Agent for a session
 * that is otherwise idle and not open in any window, and treating that as
 * "open in the app" made those sessions impossible to delete. The user has
 * already confirmed an irreversible action in the UI, so an idle holder only
 * needs to be released, not to block.
 * @param ctx - Host context with optional `agents`.
 * @param sessionId - session to check.
 * @returns a refusal object, or null when deletion may proceed.
 */
function liveRefusal(ctx, sessionId) {
  // `agents` is optional in this profile: absence simply means no live Agent
  // can be holding the log, so nothing to refuse.
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return null
  const live = agents.get(sessionId)
  if (live === undefined || live === null) return null
  if (live.status === 'running') {
    return {
      code: 'SESSION_RUNNING',
      message: '这个会话正在运行中。请先停止它，再执行删除。',
    }
  }
  return null
}

/**
 * Ask the composed providers to release whatever they still hold for this
 * session before its log is removed (a resident Agent, a subscription, a
 * watcher). Best effort: a provider that does not answer simply contributes
 * nothing, and the removal proceeds either way.
 * @param ctx - Host context.
 * @param sessionId - the session about to be removed.
 */
async function releaseSession(ctx, sessionId) {
  if (typeof ctx.parallel !== 'function') return
  try {
    await ctx.parallel('workspace/session-stop', { sessionId })
  } catch (error) {
    ctx.logger?.warn?.('dsh-session-delete: release providers failed: %s', error)
  }
}

/**
 * Defaults applied to the row's `config`. This is deliberately NOT exported as
 * `Config`: a `Config` export must be a schemastery schema whose `validate`
 * Cordis calls at activation, and a plain object fails there. The plugin needs
 * no user-tunable settings in the normal case — the sessions root is derived
 * exactly like the persistence backend derives it.
 */
const CONFIG_DEFAULTS = {
  /** Override the sessions root; empty means derive it (`$DSH_HOME/sessions`). */
  sessionsRoot: '',
}

/**
 * Services this plugin requires before it activates. `webServer` is NOT listed
 * here: it is an optional capability obtained inside `apply` through
 * `ctx.inject(['webServer'], ...)`, so the plugin stays inactive-but-healthy on
 * profiles without a web server instead of blocking activation.
 */
export const inject = []

/**
 * Resolve the sessions root the same way the JSONL persistence backend does.
 * The shipped base patch configures that backend as
 * `root: !!js dshHomePath('sessions')`, and `dshHomePath` resolves
 * `DSH_HOME` (default `~/.dsh`) + `sessions`. Config wins when an operator
 * pins an explicit path.
 * @param config - resolved plugin Config.
 * @returns absolute sessions root path.
 */
function sessionsRootOf(config) {
  if (config.sessionsRoot) return resolve(config.sessionsRoot)
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh')
  return resolve(dshHome, 'sessions')
}

/**
 * Remove the durable projection checkpoint for a session.
 *
 * The cache stores one document per session under `<dsh home>/storages/
 * session_projcache/sessions/<id>.json`, and it holds a copy of that
 * session's metadata. Deleting the log alone leaves that document behind, so
 * a "permanent delete" would still leave session data on disk.
 *
 * The preferred path is the storage domain's own `delete(key)`, which
 * maintains the domain's in-memory mirror and write chain; the direct file
 * removal is only the fallback for a profile without that service. Both are
 * best effort: a leftover checkpoint is stale, never wrong, because every
 * read validates the record's identity against the live header and discards
 * a mismatch.
 * @param ctx - Host context.
 * @param sessionId - the removed session.
 * @param sessionRoot - sessions root, used to locate the sibling storages dir.
 */
async function dropProjectionCache(ctx, sessionId, sessionRoot) {
  const domain = ctx.get('storageDomain')?.get?.('session_projcache')
  if (domain !== undefined && typeof domain.get === 'function') {
    // Report truthfully whether a checkpoint existed, so a run with no session
    // directory can still distinguish "nothing left to do" from "cleaned up".
    const existed = domain.get(sessionId) !== undefined
    try {
      await domain.delete(sessionId)
      return existed
    } catch (error) {
      ctx.logger?.warn?.('dsh-session-delete: projection cache delete failed: %s', error)
    }
  }
  // Fallback: the JSON backend's per-record layout, beside the sessions root.
  // The storages directory is a sibling of `sessions` under the DSH home.
  const file = join(dirname(resolve(sessionRoot)), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  try {
    const info = await stat(file)
    await rm(file, { force: true })
    return info.isFile()
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      ctx.logger?.warn?.('dsh-session-delete: projection cache file removal failed: %s', error)
    }
    return false
  }
}

/**
 * Remove a workspace bucket directory once the deleted session was its last
 * member. An empty bucket is harmless but lingers as a stub the user cannot
 * act on. Best effort and non-recursive by intent: `rmdir` refuses a
 * non-empty directory, so a bucket that still holds other sessions is
 * untouched.
 * @param ctx - Host context.
 * @param dir - the session directory that was just removed.
 */
async function pruneEmptyBucket(ctx, dir) {
  const bucket = dirname(resolve(dir))
  try {
    await rmdir(bucket)
    ctx.logger?.info?.('dsh-session-delete: removed empty bucket %s', bucket)
  } catch {
    // ENOTEMPTY (other sessions remain) and ENOENT (already gone) are both
    // the expected outcome; neither is worth reporting.
  }
}

/**
 * Drop a session id from every workspace record's ownership account, and from
 * the registry-global archive/pin sets.
 *
 * The workspace registry only FILTERS a gone session out of its `sessionIds`
 * getter at read time and logs a warning; it never rewrites the stored record.
 * So a plain file removal leaves the id in the durable ledger forever, and the
 * next start reports it as a filtered candidate. There is no public registry
 * API to remove a member, so this writes through the same storage domain the
 * registry itself uses — `table('workspaces').update(...)` keeps the domain's
 * in-memory mirror and write chain authoritative instead of editing the file
 * behind its back. The global sets are corrected on the same pass.
 * @param ctx - Host context.
 * @param sessionId - the removed session.
 */
async function dropLedgerEntries(ctx, sessionId) {
  const domain = typeof ctx.get === 'function' ? ctx.get('storageDomain')?.get?.('workspace') : undefined
  if (domain === undefined || typeof domain.table !== 'function') return false
  try {
    let changed = false
    const table = domain.table('workspaces')
    for (const workspaceId of domain.global?.get?.()?.workspaceIds ?? []) {
      const record = table.get(workspaceId)
      if (record === undefined || !Array.isArray(record.sessionIds)) continue
      if (!record.sessionIds.includes(sessionId)) continue
      await table.update(workspaceId, (current) => ({
        ...current,
        sessionIds: current.sessionIds.filter(id => id !== sessionId),
        updatedAt: new Date().toISOString(),
      }))
      changed = true
    }
    // The archive and pin sets are registry-global, so a stale id there
    // outlives every workspace record.
    const global = domain.global
    const state = global?.get?.()
    if (state !== undefined) {
      const next = {
        ...state,
        ...(Array.isArray(state.archivedSessionIds)
          ? { archivedSessionIds: state.archivedSessionIds.filter(id => id !== sessionId) }
          : {}),
        ...(Array.isArray(state.pinnedSessionIds)
          ? { pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId) }
          : {}),
      }
      if (JSON.stringify(next) !== JSON.stringify(state)) {
        await global.set(next)
        changed = true
      }
    }
    return changed
  } catch (error) {
    ctx.logger?.warn?.('dsh-session-delete: workspace ledger cleanup failed: %s', error)
    return false
  }
}

/**
 * Delete one session's on-disk directory.
 * @param ctx - Host context.
 * @param sessionRoot - absolute sessions root.
 * @param sessionId - validated session id.
 * @returns one of the documented result codes.
 */
async function deleteSession(ctx, sessionRoot, sessionId) {
  if (!isSafeSessionId(sessionId)) {
    return { ok: false, code: 'BAD_SESSION_ID', message: '会话 ID 不合法。' }
  }
  // Re-check AFTER releasing holders too: releasing can itself wake work, and
  // a turn that starts between the check and the removal would append into a
  // directory that is about to vanish.
  let refusal = liveRefusal(ctx, sessionId)
  if (refusal !== null) return { ok: false, ...refusal }
  const dirs = await findSessionDirs(sessionRoot, sessionId)
  // A missing directory is NOT an immediate failure: the log may already be
  // gone while the derived data (projection checkpoint, workspace ledger
  // entry) still lingers — exactly the state an earlier deletion by a build
  // without those cleanups leaves behind. Those are cleaned below, and only a
  // run that finds nothing at all reports NOT_FOUND.
  const hasDir = dirs.length > 0
  if (hasDir) {
    // Let resident holders (an idle Agent, subscriptions) let go before the log
    // disappears, so nothing keeps appending to a removed path.
    await releaseSession(ctx, sessionId)
    refusal = liveRefusal(ctx, sessionId)
    if (refusal !== null) return { ok: false, ...refusal }
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true })
      ctx.logger?.info?.('dsh-session-delete: removed %s', dir)
    }
  }
  // Everything derived from the log goes with it, so the removal is complete
  // rather than merely hiding the session.
  const prunedCache = await dropProjectionCache(ctx, sessionId, sessionRoot)
  const prunedLedger = await dropLedgerEntries(ctx, sessionId)
  for (const dir of dirs) await pruneEmptyBucket(ctx, dir)
  if (!hasDir && !prunedCache && !prunedLedger) {
    return { ok: false, code: 'NOT_FOUND', message: '没有找到这个会话的数据，可能已经被删除了。' }
  }
  // Tell the UI the row is gone. The session list is otherwise rebuilt only
  // from a live `session/disposed`, which a plain file removal never raises, so
  // without this the deleted row would linger until a reload.
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch (error) {
    ctx.logger?.warn?.('dsh-session-delete: could not announce removal: %s', error)
  }
  return { ok: true, sessionId, removed: dirs }
}

/**
 * Plugin entry: register the same-origin deletion route when a web server
 * exists in this profile.
 * @param ctx - Host context.
 * @param config - the row's config, merged over the defaults.
 */
export function apply(ctx, config) {
  const resolved = { ...CONFIG_DEFAULTS, ...(config ?? {}) }
  ctx.inject(['webServer'], (webCtx) => {
    const sessionRoot = sessionsRootOf(resolved)
    const handler = async (req, res) => {
      const violation = sameOriginViolation(req)
      if (violation !== null) {
        sendJson(res, 403, { ok: false, code: 'BAD_ORIGIN', message: violation })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '请使用 POST 请求。' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, code: 'BAD_BODY', message: String(error && error.message ? error.message : error) })
        return
      }
      try {
        const result = await deleteSession(webCtx, sessionRoot, body.sessionId)
        sendJson(res, result.ok ? 200 : 409, result)
      } catch (error) {
        webCtx.logger?.warn?.('dsh-session-delete: failed: %s', error)
        sendJson(res, 500, { ok: false, code: 'DELETE_FAILED', message: String(error && error.message ? error.message : error) })
      }
    }
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: '/session-delete', handler }),
      'dsh-session-delete: delete route',
    )
  })
}
