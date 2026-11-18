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
import { join, resolve, sep, dirname, basename } from 'node:path'

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
 * The Host / Origin / Sec-Fetch-Site half of DSH's browser-trust fence.
 *
 * `webServer.register` does NOT apply DSH's connection trust check, so a
 * loopback bind alone does not make this route safe: a page on another origin,
 * or a DNS-rebinding Host header, still reaches it. This mirrors
 * `isTrustedApiRequest` in client-connection/api-request-trust.ts, and is the
 * same fence `dsh-session-api` runs in production.
 *
 * The route is destructive, so the fence is mandatory rather than optional: the
 * previous guard accepted a missing Origin and compared Origin against the
 * caller-supplied Host, which let a caller forge both and delete a session.
 * @param req - the incoming request.
 * @returns a refusal message, or undefined when the request passes.
 */
export function requestFence(req) {
  const host = String(req.headers?.host ?? '')
  if (host.length === 0) return '请求缺少 Host 头。'
  let authority
  try {
    authority = new URL(`http://${host}`)
  } catch {
    return 'Host 头无法解析。'
  }
  // The Host header is the one header DNS rebinding cannot forge: the browser
  // fills it from the address it believes it is talking to.
  const hostname = authority.hostname.toLowerCase()
  const loopback = hostname === 'localhost'
    || hostname === '[::1]'
    || hostname === '::1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  if (!loopback) return 'Host 头不是本机地址（可能是 DNS 重绑定）。'
  // An explicit cross-site marker is refused regardless of Origin.
  if (String(req.headers?.['sec-fetch-site'] ?? '') === 'cross-site') {
    return '拒绝跨站请求。'
  }
  // A browser that attaches an Origin must name this very authority. An absent
  // Origin is fine: the Host fence above already bound the request.
  const origin = req.headers?.origin
  if (origin === undefined) return undefined
  const text = String(origin)
  if (text === 'null') return '拒绝 opaque origin（沙箱页面或本地文件页）。'
  let originUrl
  try {
    originUrl = new URL(text)
  } catch {
    return 'Origin 头无法解析。'
  }
  if (originUrl.host.toLowerCase() !== authority.host.toLowerCase()) {
    return 'Origin 与 Host 不一致（跨站请求）。'
  }
  return undefined
}

/**
 * Whether a directory really holds a session log.
 *
 * A name alone proves nothing: `attachments` and `.git` are legal single path
 * segments, and both were once removed as if they were sessions. A genuine
 * session directory carries the log, or — for a session created but not yet
 * written — at least the lock file.
 * @param dir - absolute candidate directory.
 * @returns true when the directory looks like a session artifact.
 */
export async function looksLikeSessionDir(dir) {
  for (const marker of ['session.v4.jsonl.zstd', 'session.lock']) {
    try {
      const info = await stat(join(dir, marker))
      if (info.isFile()) return true
    } catch {
      // try the next marker
    }
  }
  return false
}

/**
 * Locate the ONE session directory the user acted on.
 *
 * A session id is `session-<uuid>`, unique per creation, and its bucket is
 * derived from that session's own cwd — so the same id under two buckets means
 * two independent copies (a hand-copied profile, a restored backup), not one
 * session with two homes.
 *
 * Resolution order:
 *   1. The session's recorded cwd → its exact bucket. This is the copy the
 *      session actually belongs to.
 *   2. A scan of every bucket, for a session whose cwd is unknown. Only a
 *      directory that really holds a session log qualifies, so an ordinary
 *      directory that happens to share the name is never removed.
 *
 * An ambiguous result (two or more genuine copies) is NOT resolved by picking
 * one: silently destroying a copy the user may have kept on purpose exceeds
 * what the click asked for. The candidates are returned instead, and the caller
 * refuses with a message naming them.
 * @param ctx - Host context, used to read the recorded header.
 * @param sessionRoot - absolute sessions root.
 * @param sessionId - validated id.
 * @returns the directory to remove (or undefined), plus candidates when ambiguous.
 */
export async function findSessionDir(ctx, sessionRoot, sessionId) {
  const root = resolve(sessionRoot)
  // Preferred: ask persistence where this session's log lives. The backend's
  // own encoder decides the bucket name, so no re-implementation can drift.
  const recorded = await findViaRecordedCwd(ctx, root, sessionId)
  if (recorded.dir !== undefined) {
    return { dir: recorded.dir, candidates: [], duplicates: recorded.duplicates, ambiguous: false }
  }
  const matches = await scanBuckets(root, sessionId)
  if (matches.length === 0) {
    return { dir: undefined, candidates: [], duplicates: [], ambiguous: false }
  }
  if (matches.length > 1) {
    // Refuse rather than choose. The confirmation dialog can name every copy,
    // and the user decides which one (or both) to remove next time.
    ctx.logger?.warn?.(
      'dsh-session-delete: %d copies of %s found (%s); refusing to pick one',
      matches.length, sessionId, matches.join(', '),
    )
    return { dir: undefined, candidates: matches, duplicates: [], ambiguous: true }
  }
  return { dir: matches[0], candidates: matches, duplicates: [], ambiguous: false }
}

/**
 * Resolve the bucket from the session's recorded cwd, then confirm the
 * directory exists. Used as the authoritative path when persistence can
 * report the header.
 * @param ctx - Host context.
 * @param root - resolved sessions root.
 * @param sessionId - validated id.
 * @returns the directory and any other copies found.
 */
async function findViaRecordedCwd(ctx, root, sessionId) {
  const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
  if (persistence === undefined || typeof persistence.stat !== 'function') {
    return { dir: undefined, duplicates: [] }
  }
  let header
  try {
    const snapshot = await persistence.stat(sessionId)
    header = snapshot?.header
  } catch {
    return { dir: undefined, duplicates: [] }
  }
  const cwd = header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return { dir: undefined, duplicates: [] }
  // Import lazily so the plugin still loads where the encoder is unavailable.
  let projectKey
  try {
    const format = await import('@deepseek-ai/dsh-session-persistence-jsonl/format')
    projectKey = format.projectKey
  } catch {
    return { dir: undefined, duplicates: [] }
  }
  if (typeof projectKey !== 'function') return { dir: undefined, duplicates: [] }
  let bucket
  try {
    bucket = projectKey(cwd)
  } catch {
    return { dir: undefined, duplicates: [] }
  }
  const candidate = resolveSessionDir(root, bucket, sessionId)
  if (candidate === undefined) return { dir: undefined, duplicates: [] }
  try {
    const info = await stat(candidate)
    if (!info.isDirectory()) return { dir: undefined, duplicates: [] }
  } catch {
    return { dir: undefined, duplicates: [] }
  }
  // Report copies outside the authoritative bucket so the caller can log them.
  const others = (await scanBuckets(root, sessionId)).filter(dir => dir !== candidate)
  if (others.length > 0) {
    ctx.logger?.warn?.(
      'dsh-session-delete: %s also appears in %d other bucket(s); removing only the recorded one (%s): %s',
      sessionId, others.length, candidate, others.join(', '),
    )
  }
  return { dir: candidate, duplicates: others }
}

/**
 * List every bucket that holds a directory named exactly this id.
 * @param root - resolved sessions root.
 * @param sessionId - validated id.
 * @returns absolute session directories, in bucket order.
 */
async function scanBuckets(root, sessionId) {
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
      // A directory is not a session just because it shares the name. Without
      // this check, a legal-looking segment such as `attachments` or `.git`
      // would be removed recursively as if it were a log.
      if (info.isDirectory() && await looksLikeSessionDir(candidate)) found.push(candidate)
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
 * Retire the live holders of a session before its log disappears.
 *
 * A bot integration (a chat bridge, for example) keeps a resident Agent for a
 * session long after its turn ended. Removing the directory underneath it leaves
 * that Agent appending to a path that no longer exists, and leaves the session
 * in the in-memory registry so every read still reports it — the "ghost session"
 * state that makes an integration look broken until the next restart.
 *
 * This runs the retirement it can reach from outside an owner's scope:
 *   1. cancel, so no turn keeps writing while the directory is being removed;
 *   2. wait for quiescence, so buffered events reach disk before it is deleted;
 *   3. ask the composed providers to release whatever they still hold.
 *
 * The owner's own detach closure is NOT reachable here (it belongs to the
 * plugin that created the Agent), so the registry entry itself may outlive this
 * call. That is why the removal announces itself on a plugin-owned event —
 * `session-delete/removed` — so an integration can drop the session id it
 * cached without parsing our files.
 * @param ctx - Host context.
 * @param sessionId - the session about to be removed.
 * @returns what was observed, for the log line.
 */
async function retireSession(ctx, sessionId) {
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  const live = agents !== undefined && typeof agents.get === 'function'
    ? agents.get(sessionId)
    : undefined
  const hadLiveAgent = live !== undefined && live !== null
  let cancelled = false
  if (hadLiveAgent) {
    // Drain BEFORE cancelling. Cancelling first would leave the session broken
    // if the removal later aborts (the second running-check, a layout guard, a
    // filesystem error): the Agent would be cancelled and the session still on
    // disk, which is strictly worse than the state the user asked to leave.
    // An idle Agent — the common case this path exists for — returns from
    // whenIdle() immediately, so nothing is cancelled at all.
    //
    // `disposed` is the loop's own cause for "this Agent is going away"; it
    // stops the turn without pretending the user cancelled it.
    let idle = false
    try {
      if (typeof live.whenIdle === 'function') {
          // Bounded: the route runs inside an HTTP request the user is watching,
          // so a wedged Agent must not turn "delete" into an unanswerable
          // spinner. Giving up the wait falls through to the cancel below.
          await withTimeout(live.whenIdle(), IDLE_TIMEOUT_MS, 'whenIdle')
        idle = true
      }
    } catch (error) {
      ctx.logger?.warn?.('dsh-session-delete: waiting for the live agent failed: %s', error)
    }
    if (!idle) {
      // Still working (or the wait timed out): stop it so the directory is not
      // being appended to while it is removed.
      try {
        if (typeof live.cancel === 'function') {
          live.cancel({ kind: 'disposed' })
          cancelled = true
        }
      } catch (error) {
        ctx.logger?.warn?.('dsh-session-delete: could not stop the live agent: %s', error)
      }
    }
    // A cancelled turn still owes a final write. Waiting for quiescence is what
    // keeps that write from recreating files under a path being removed.
  }
  // Providers that hold their own subscription or watcher get a chance to let
  // go. Best effort by design: a provider that does not answer contributes
  // nothing, and the removal proceeds.
  if (typeof ctx.parallel === 'function') {
    try {
      await ctx.parallel('workspace/session-stop', { sessionId })
    } catch (error) {
      ctx.logger?.warn?.('dsh-session-delete: release providers failed: %s', error)
    }
  }
  // Give the final flush a moment even after quiescence: the writer's last
  // append is asynchronous with respect to the Agent's idle signal.
  await new Promise(resolveWait => setTimeout(resolveWait, STOP_SETTLE_MS))
  return { hadLiveAgent, cancelled }
}

/**
 * Await a promise, but not forever.
 *
 * The deletion route runs inside an HTTP request the user is waiting on. Every
 * await in it must therefore be bounded: a holder that never settles would
 * turn "delete this session" into an unanswerable spinner, which is worse than
 * a deletion that proceeds while the holder is still winding down (the
 * retrying `rm` handles that case).
 * @param promise - the work to bound.
 * @param ms - budget in milliseconds.
 * @param label - name used in the timeout error.
 * @returns the promise's value.
 */
function withTimeout(promise, ms, label) {
  let timer
  const budget = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    // A rejected race must not keep the process alive on its own.
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, budget]).finally(() => clearTimeout(timer))
}

/** Deletions currently running, keyed by session id, so duplicates share one outcome. */
const DELETIONS = new Map()

/** Budget for a holder to reach quiescence before the delete proceeds anyway. */
const IDLE_TIMEOUT_MS = 5000
/** How many times a transiently busy directory removal is retried. */
const RM_RETRY = 6
/** Wait between those retries, in milliseconds. */
const RM_RETRY_GAP_MS = 150
/**
 * How long to let a cancelled Agent's final events reach disk after asking the
 * providers to stop. Removing the directory while that flush is still in
 * flight lets the writer recreate files under a path that is disappearing.
 */
const STOP_SETTLE_MS = 400

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
 * Whether a removal error means "something else is holding the file", the
 * shape Windows reports for an antivirus scanner or the search indexer briefly
 * keeping a handle on a just-closed log. Retrying is the documented remedy.
 * @param error - the error thrown by `rm`.
 * @returns true for the transient busy/permission family.
 */
function isBusyError(error) {
  const code = error?.code
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY'
}

/**
 * Remove a session directory, retrying the transient busy family.
 *
 * A resident Agent's final flush, an antivirus scan or the search indexer can
 * hold the log for a moment after it is closed; a single `rm` then fails on an
 * otherwise deletable session. The wait is short and bounded, and a permanent
 * error still surfaces immediately instead of being masked by the retries.
 * @param target - absolute directory to remove recursively.
 */
async function rmWithRetry(target) {
  let last
  for (let attempt = 0; attempt < RM_RETRY; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch (error) {
      if (!isBusyError(error)) throw error
      last = error
      await new Promise(resolveWait => setTimeout(resolveWait, RM_RETRY_GAP_MS))
    }
  }
  throw last
}

/**
 * Delete one session's on-disk directory.
 * @param ctx - Host context.
 * @param sessionRoot - absolute sessions root.
 * @param sessionId - validated session id.
 * @returns one of the documented result codes.
 */
async function deleteSession(ctx, sessionRoot, sessionId) {
  // One deletion per session at a time.
  //
  // Two requests for the same id used to interleave: both passed the guards,
  // both removed, and both announced — so a subscriber saw `removed` twice and
  // had no way to tell a real second deletion from a duplicate. A second
  // concurrent request now waits for the first outcome and answers with it,
  // which is what the caller meant either way.
  const inFlight = DELETIONS.get(sessionId)
  if (inFlight !== undefined) return inFlight
  const attempt = deleteSessionOnce(ctx, sessionRoot, sessionId)
  DELETIONS.set(sessionId, attempt)
  try {
    return await attempt
  } finally {
    DELETIONS.delete(sessionId)
  }
}

/**
 * The deletion body, run once per session at a time by {@link deleteSession}.
 * @param ctx - Host context.
 * @param sessionRoot - absolute sessions root.
 * @param sessionId - validated session id.
 * @returns one of the documented result codes.
 */
async function deleteSessionOnce(ctx, sessionRoot, sessionId) {
  if (!isSafeSessionId(sessionId)) {
    return { ok: false, code: 'BAD_SESSION_ID', message: '会话 ID 不合法。' }
  }
  // Re-check AFTER releasing holders too: releasing can itself wake work, and
  // a turn that starts between the check and the removal would append into a
  // directory that is about to vanish.
  let refusal = liveRefusal(ctx, sessionId)
  if (refusal !== null) return { ok: false, ...refusal }
  const located = await findSessionDir(ctx, sessionRoot, sessionId)
  // Two genuine copies: refuse rather than pick one. Removing a copy the user
  // kept on purpose is worse than making them choose.
  if (located.ambiguous === true) {
    return {
      ok: false,
      code: 'AMBIGUOUS_LOCATION',
      message: `发现 ${located.candidates.length} 份同名会话数据，为避免删错已中止。请确认要删除哪一份：\n${located.candidates.join('\n')}`,
      candidates: located.candidates,
    }
  }
  const dir = located.dir
  // A missing directory is NOT an immediate failure: the log may already be
  // gone while the derived data (projection checkpoint, workspace ledger
  // entry) still lingers — exactly the state an earlier deletion by a build
  // without those cleanups leaves behind. Those are cleaned below, and only a
  // run that finds nothing at all reports NOT_FOUND.
  if (dir !== undefined) {
    // Defence in depth: the directory must be named exactly after the id.
    // A backend layout change that put the artifact somewhere unexpected must
    // never turn a recursive removal into a whole-bucket wipe.
    if (basename(dir) !== sessionId) {
      return {
        ok: false,
        code: 'UNEXPECTED_LAYOUT',
        message: '解析出的路径不在会话目录内，已中止删除。',
      }
    }
    // Retire resident holders before the log disappears, so nothing keeps
    // appending to a removed path and the session does not linger in the
    // in-memory registry as a ghost row.
    const retirement = await retireSession(ctx, sessionId)
    if (retirement.hadLiveAgent) {
      ctx.logger?.info?.(
        'dsh-session-delete: retired live agent for %s (cancelled=%s)',
        sessionId, String(retirement.cancelled),
      )
    }
    // Re-check after releasing: releasing can itself wake work, and a turn that
    // starts now would append into a directory about to vanish.
    refusal = liveRefusal(ctx, sessionId)
    if (refusal !== null) return { ok: false, ...refusal }
    await rmWithRetry(dir)
    ctx.logger?.info?.('dsh-session-delete: removed %s', dir)
  }
  // Everything derived from the log goes with it, so the removal is complete
  // rather than merely hiding the session.
  const prunedCache = await dropProjectionCache(ctx, sessionId, sessionRoot)
  const prunedLedger = await dropLedgerEntries(ctx, sessionId)
  if (dir !== undefined) await pruneEmptyBucket(ctx, dir)
  if (dir === undefined && !prunedCache && !prunedLedger) {
    return { ok: false, code: 'NOT_FOUND', message: '没有找到这个会话的数据，可能已经被删除了。' }
  }
  // Announce to two different audiences.
  //
  // `session-delete/removed` is ours: an integration that cached this session id
  // in its own file (a chat bridge mapping a user to a session, for example) has
  // no other way to learn the id is gone, because DSH's `session/disposed` needs
  // the live Session object and is scoped to its owner. Without a signal, the
  // cached id is pointed at a directory that no longer exists, and the
  // integration reports a broken session instead of starting a fresh one.
  //
  // `api-session/removed` is DSH's own UI notification for "this row left the
  // registry"; the session list is otherwise rebuilt only from a live
  // `session/disposed`, which a plain file removal never raises, so without it
  // the deleted row lingers until a reload. Emitting it here is a deliberate
  // stand-in for the retirement DSH does not offer for plugins.
  for (const [name, payload] of [
    ['session-delete/removed', { sessionId, paths: dir === undefined ? [] : [dir] }],
    ['api-session/removed', sessionId],
  ]) {
    try {
      ctx.emit(name, payload)
    } catch (error) {
      ctx.logger?.warn?.('dsh-session-delete: could not announce %s: %s', name, error)
    }
  }
  return {
    ok: true,
    sessionId,
    removed: dir === undefined ? [] : [dir],
    ...(located.duplicates.length === 0 ? {} : { untouchedDuplicates: located.duplicates }),
  }
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
      const violation = requestFence(req)
      if (violation !== undefined) {
        sendJson(res, 403, { ok: false, code: 'UNTRUSTED_CONNECTION', message: violation })
        return
      }
      // Content type stays required and stays separate from the trust fence: a
      // cross-site HTML form cannot set it, so it is a second independent gate
      // on the destructive route.
      const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        sendJson(res, 415, { ok: false, code: 'BAD_CONTENT_TYPE', message: '请求必须是 application/json 类型' })
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
      // A JSON document of any shape parses; only an object can carry a
      // sessionId. Without this, `null` reaches the id validation and surfaces
      // as a 500 carrying a JavaScript message about reading properties of null
      // — an internal detail the caller has no use for, on a route that answers
      // with codes.
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { ok: false, code: 'BAD_BODY_SHAPE', message: '请求体必须是一个 JSON 对象。' })
        return
      }
      try {
        const result = await deleteSession(webCtx, sessionRoot, body.sessionId)
        sendJson(res, result.ok ? 200 : 409, result)
      } catch (error) {
        webCtx.logger?.warn?.('dsh-session-delete: failed: %s', error)
        // A filesystem failure is reported as a failure, not as a crash, and
        // without the absolute path: the message is rendered in the confirmation
        // dialog, and an internal path there tells the user nothing they can act
        // on while exposing their directory layout.
        sendJson(res, 500, {
          ok: false,
          code: 'DELETE_FAILED',
          message: error?.code === 'EACCES' || error?.code === 'EPERM'
            ? '没有权限删除这个会话的日志文件，可能被其他程序占用。'
            : '删除时出错，会话可能没有被完全清除。',
        })
      }
    }
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: '/session-delete', handler }),
      'dsh-session-delete: delete route',
    )
  })
}
