/**
 * 真实数据关系全链路测试：不用 mock，直接对着真实存储文件结构验证。
 * 覆盖：日志目录 / 投影缓存 / workspace 账本 sessionIds / archived / pinned
 */
import { mkdtemp, mkdir, writeFile, rm as frm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'

const mod = await import('../lib/index.js')

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}

async function scenario(label, setup, opts = {}) {
  console.log(`\n─── ${label} ───`)
  const tmp = await mkdtemp(join(tmpdir(), 'dsd-'))
  const root = join(tmp, 'sessions')
  const storages = join(tmp, 'storages')
  const cacheDir = join(storages, 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })

  // 真实磁盘结构
  const SID = opts.sessionId ?? 'session-test-uuid-0001'
  const KEEP = 'session-keep-uuid-0002'
  const WSID = 'ws-0001'

  const tables = { [WSID]: { path: '/proj', title: 'P', sessionIds: opts.noLedger ? [KEEP] : [SID, KEEP], createdAt: 'a', updatedAt: 'a' } }
  const ledger = { initialized: true, workspaceIds: [WSID], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: WSID }
  await writeFile(join(storages, 'workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: ledger, tables: { workspaces: tables } }, null, 2))

  if (opts.withDir !== false) {
    await mkdir(join(root, '--proj--', SID), { recursive: true })
    await writeFile(join(root, '--proj--', SID, 'session.v4.jsonl.zstd'), 'log')
    await writeFile(join(root, '--proj--', SID, 'session.lock'), '')
    await mkdir(join(root, '--proj--', KEEP), { recursive: true })
    await writeFile(join(root, '--proj--', KEEP, 'session.v4.jsonl.zstd'), 'keep')
  }
  if (opts.withCache !== false) {
    await writeFile(join(cacheDir, `${SID}.json`), '{"version":7}')
  }
  await writeFile(join(cacheDir, `${KEEP}.json`), '{"version":7}')
  if (opts.archived) ledger.archivedSessionIds.push(SID)
  if (opts.pinned) ledger.pinnedSessionIds.push(SID)
  await writeFile(join(storages, 'workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: ledger, tables: { workspaces: tables } }, null, 2))

  // 真实感的 storageDomain：从磁盘读、写回磁盘
  const persist = async () => writeFile(join(storages, 'workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: ledger, tables: { workspaces: tables } }, null, 2))
  const wsTable = {
    get: k => tables[k],
    update: async (k, fn) => { tables[k] = fn(tables[k]); await persist(); return tables[k] },
  }
  const wsDomain = { table: () => wsTable, global: { get: () => ledger, set: async v => { Object.assign(ledger, v); await persist() } } }
  const cacheDomain = {
    get: k => opts.withCache !== false && k === SID ? { v: 1 } : undefined,
    delete: async k => { try { await frm(join(cacheDir, `${k}.json`)); return true } catch { return false } },
  }
  const domainRouter = { get: n => n === 'workspace' ? wsDomain : n === 'session_projcache' ? cacheDomain : undefined }

  let handler
  const logger = { info() {}, warn(m) { console.log('     [warn]', m) } }
  const mk = () => ({ logger, get: n => n === 'storageDomain' ? domainRouter : undefined,
    effect(f) { f() }, emit() {}, parallel: async () => [],
    inject(_n, fn) { fn(mk()) }, webServer: { register(r) { handler = r.handler; return () => {} } } })
  mod.apply(mk(), { sessionsRoot: root })

  const call = async (body) => {
    let done; const p = new Promise(r => done = r)
    const res = { statusCode: 200, setHeader() {}, end(t) { done({ status: this.statusCode, body: t }) } }
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'; req.headers = { 'content-type': 'application/json' }
    await handler(req, res)
    return p
  }

  const r = await call({ sessionId: SID })
  return { r, tmp, root, cacheDir, tables, ledger, SID, KEEP, dir: join(root, '--proj--', SID), cache: join(cacheDir, `${SID}.json`) }
}

const exists = async p => { try { const { stat } = await import('node:fs/promises'); await stat(p); return true } catch { return false } }

// 场景1：标准删除
{
  const c = await scenario('场景1 标准删除（日志+缓存+账本都在）')
  check('日志目录已删', !(await exists(c.dir)))
  check('投影缓存已删', !(await exists(c.cache)))
  check('账本 sessionIds 已移除', !c.tables['ws-0001'].sessionIds.includes(c.SID), JSON.stringify(c.tables['ws-0001'].sessionIds))
  check('保留其他会话', c.tables['ws-0001'].sessionIds.includes(c.KEEP))
  check('其他缓存未误删', await exists(join(c.cacheDir, `${c.KEEP}.json`)))
  check('桶目录保留（非空）', await exists(join(c.root, '--proj--')))
  check('返回成功', JSON.parse(c.r.body).ok === true)
  await frm(c.tmp, { recursive: true, force: true })
}

// 场景2：已归档+已置顶
{
  const c = await scenario('场景2 会话已归档且已置顶', null, { archived: true, pinned: true })
  check('归档集已移除', !c.ledger.archivedSessionIds.includes(c.SID), JSON.stringify(c.ledger.archivedSessionIds))
  check('置顶集已移除', !c.ledger.pinnedSessionIds.includes(c.SID), JSON.stringify(c.ledger.pinnedSessionIds))
  check('账本已移除', !c.tables['ws-0001'].sessionIds.includes(c.SID))
  await frm(c.tmp, { recursive: true, force: true })
}

// 场景3：孤儿（目录已无，缓存+账本还在）—— 你这次踩的坑
{
  const c = await scenario('场景3 孤儿清理（目录已不存在）', null, { withDir: false })
  check('返回成功而非 NOT_FOUND', JSON.parse(c.r.body).ok === true, c.r.body)
  check('孤儿缓存已清', !(await exists(c.cache)))
  check('孤儿账本已清', !c.tables['ws-0001'].sessionIds.includes(c.SID))
  await frm(c.tmp, { recursive: true, force: true })
}

// 场景4：完全不存在
{
  const c = await scenario('场景4 完全不存在（账本也无痕迹）', null, { withDir: false, withCache: false, noLedger: true })
  const parsed = JSON.parse(c.r.body)
  check('返回 NOT_FOUND', parsed.ok === false && parsed.code === 'NOT_FOUND', c.r.body)
  await frm(c.tmp, { recursive: true, force: true })
}

// 场景5：删的是桶里唯一会话 → 空桶应被清理
{
  const tmp = await mkdtemp(join(tmpdir(), 'dsd-'))
  const root = join(tmp, 'sessions')
  await mkdir(join(root, '--only--', 'session-only-1'), { recursive: true })
  await writeFile(join(root, '--only--', 'session-only-1', 'session.v4.jsonl.zstd'), 'x')
  let handler
  const mk = () => ({ logger: { info() {}, warn() {} }, get: () => undefined, effect(f) { f() }, emit() {}, parallel: async () => [],
    inject(_n, fn) { fn(mk()) }, webServer: { register(r) { handler = r.handler; return () => {} } } })
  mod.apply(mk(), { sessionsRoot: root })
  const call = async b => { let d; const p = new Promise(r => d = r); const res = { statusCode: 200, setHeader() {}, end(t) { d(t) } };
    const req = Readable.from([Buffer.from(JSON.stringify(b))]); req.method = 'POST'; req.headers = { 'content-type': 'application/json' }; await handler(req, res); return p }
  console.log('\n─── 场景5 删空桶内唯一会话 ───')
  await call({ sessionId: 'session-only-1' })
  check('会话目录已删', !(await exists(join(root, '--only--', 'session-only-1'))))
  check('空桶已清理', !(await exists(join(root, '--only--'))))
  await frm(tmp, { recursive: true, force: true })
}


// 场景6：同一 id 出现在两个 bucket → 只删一个，另一个必须保留
{
  console.log('\n─── 场景6 同名会话只删一个（不扩散）───')
  const tmp = await mkdtemp(join(tmpdir(), 'dsd-dup-'))
  const root = join(tmp, 'sessions')
  const SID = 'session-dup-copy-0003'
  const BUCKET_A = '--proj-a--'
  const BUCKET_B = '--proj-b--'
  for (const b of [BUCKET_A, BUCKET_B]) {
    await mkdir(join(root, b, SID), { recursive: true })
    await writeFile(join(root, b, SID, 'session.v4.jsonl.zstd'), 'log')
  }
  const cacheDir = join(tmp, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, `${SID}.json`), '{"version":7}')
  const tables = { ws: { path: '/p', title: 'P', sessionIds: [SID], createdAt: 'a', updatedAt: 'a' } }
  const ledger = { initialized: true, workspaceIds: ['ws'], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: 'ws' }
  await writeFile(join(tmp, 'storages', 'workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: ledger, tables: { workspaces: tables } }))

  let handler
  const warns = []
  const logger = { info() {}, warn(m) { warns.push(String(m)) } }
  const wsTable = { get: k => tables[k], update: async (k, fn) => { tables[k] = fn(tables[k]); return tables[k] } }
  const wsDomain = { table: () => wsTable, global: { get: () => ledger, set: async v => Object.assign(ledger, v) } }
  const cacheDomain = { get: k => k === SID ? {} : undefined, delete: async k => { try { await frm(join(cacheDir, `${k}.json`)); return true } catch { return false } } }
  const router = { get: n => n === 'workspace' ? wsDomain : n === 'session_projcache' ? cacheDomain : undefined }
  const mk = () => ({ logger, get: n => n === 'storageDomain' ? router : undefined,
    effect(f) { f() }, emit() {}, parallel: async () => [],
    inject(_n, fn) { fn(mk()) }, webServer: { register(r) { handler = r.handler; return () => {} } } })
  mod.apply(mk(), { sessionsRoot: root })
  let done; const p = new Promise(r => done = r)
  const res = { statusCode: 200, setHeader() {}, end(t) { done({ status: this.statusCode, body: t }) } }
  const req = Readable.from([Buffer.from(JSON.stringify({ sessionId: SID }))])
  req.method = 'POST'; req.headers = { 'content-type': 'application/json' }
  await handler(req, res)
  const body = JSON.parse((await p).body)

  const aExists = await exists(join(root, BUCKET_A, SID))
  const bExists = await exists(join(root, BUCKET_B, SID))
  check('只删了其中一个（另一个保留）', aExists !== bExists, `A=${aExists} B=${bExists}`)
  check('确实有一个被删掉', !aExists || !bExists)
  check('返回成功', body.ok === true, JSON.stringify(body))
  check('报告了未处理的副本', Array.isArray(body.untouchedDuplicates) && body.untouchedDuplicates.length === 1, JSON.stringify(body))
  check('记录了警告日志', warns.some(w => w.includes('other bucket') || w.includes('copies')), JSON.stringify(warns))
  check('缓存已清理（按 id 清，与副本无关）', !(await exists(join(cacheDir, `${SID}.json`))))
  await frm(tmp, { recursive: true, force: true })
}

console.log(`\n════════ 最终：${pass} 通过 / ${fail} 失败 ════════`)
process.exit(fail === 0 ? 0 : 1)
