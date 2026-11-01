'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')

const ROOT = path.resolve(__dirname, '..')
const GATEWAY = path.join(ROOT, 'gateway.js')
const TOKEN = 'tunnel-test-token'

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function waitForHealth(base, child, logs, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`gateway exited early (${child.exitCode})\n${logs.join('')}`)
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })
      if (response.ok) return
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`gateway did not become healthy: ${lastError?.message || 'timeout'}\n${logs.join('')}`)
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  const done = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 3000)),
  ])
  if (!done) {
    child.kill('SIGKILL')
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))])
  }
}

function auth(extra = {}) {
  return { authorization: `Bearer ${TOKEN}`, 'x-dsh-remote-client': 'admin', ...extra }
}

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      last = error
    }
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  throw new Error('condition not met in time' + (last ? `: ${last.message}` : ''))
}

function writeFakeScript(file, body) {
  fs.writeFileSync(file, body, 'utf8')
  return file
}

test('Cloudflare 隧道随网关启停、日志可见且退出后自动重启', { timeout: 60_000 }, async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-tunnel-'))
  const gatewayPort = await freePort()
  const upstreamPort = await freePort()
  const configFile = path.join(tmpRoot, '.dsh-remote', 'tunnel.json')
  const logFile = path.join(tmpRoot, '.dsh-remote', 'cloudflared.log')
  const fakeTunnel = writeFakeScript(path.join(tmpRoot, 'fake-tunnel.mjs'), [
    "console.log('INF Requesting new quick Tunnel on trycloudflare.com...')",
    "console.log('INF |  https://tunnel-test-abc.trycloudflare.com  |')",
    "console.log('INF Registered tunnel connection connIndex=0')",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
  const fakeCrash = writeFakeScript(path.join(tmpRoot, 'fake-crash.mjs'), [
    "console.log('INF |  https://tunnel-crash-abc.trycloudflare.com  |')",
    "console.log('INF Registered tunnel connection connIndex=0')",
    'setTimeout(() => process.exit(7), 500)',
    '',
  ].join('\n'))

  const upstream = http.createServer((req, res) => {
    res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'application/json' })
    res.end(req.url === '/' ? '{"ok":true}' : '{}')
  })
  await new Promise((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(upstreamPort, '127.0.0.1', resolve)
  })

  const logs = []
  let child = null
  const start = async () => {
    child = spawn(process.execPath, [GATEWAY], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: tmpRoot,
        USERPROFILE: tmpRoot,
        PORT: String(gatewayPort),
        HOST: '127.0.0.1',
        DSH_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
        TOKEN,
        TOKEN_FILE: path.join(tmpRoot, 'token'),
        DSH_REMOTE_FS_ROOT: tmpRoot,
        DSH_REMOTE_TUNNEL_CONFIG: configFile,
        DSH_REMOTE_TUNNEL_LOG: logFile,
        DSH_REMOTE_ANNOUNCEMENTS_URL: '',
        DSH_REMOTE_DSH_CONTROL_MODE: 'disabled',
        UPDATE_CHECK_URL: 'http://127.0.0.1:1/update',
        UPDATE_INTERVAL_MS: '3600000',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        NO_PROXY: '*',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => logs.push(String(chunk)))
    child.stderr.on('data', chunk => logs.push(String(chunk)))
    return waitForHealth(`http://127.0.0.1:${gatewayPort}`, child, logs)
  }

  t.after(async () => {
    await stopChild(child)
    await new Promise(resolve => upstream.close(resolve))
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  const base = `http://127.0.0.1:${gatewayPort}`
  await start()

  const tunnel = async (query = '?lines=100') => {
    const response = await fetch(`${base}/admin/api/tunnel${query}`, { headers: auth() })
    assert.equal(response.status, 200)
    return response.json()
  }
  const configure = async (body) => {
    const response = await fetch(`${base}/admin/api/tunnel/config`, {
      method: 'POST',
      headers: auth({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
    const payload = await response.json()
    return { status: response.status, payload }
  }

  // 默认未启用
  let state = await tunnel()
  assert.equal(state.enabled, false)
  assert.equal(state.status, 'stopped')
  assert.equal(state.pid, 0)

  // 非法配置被拒绝
  assert.equal((await configure({ mode: 'bogus' })).status, 400)

  // 启用: 用 node + fake 脚本模拟 cloudflared, 验证 URL 解析与日志
  const enabled = await configure({ enabled: true, mode: 'quick', binary: process.execPath, extraArgs: [fakeTunnel] })
  assert.equal(enabled.status, 200)
  assert.equal(enabled.payload.enabled, true)

  state = await waitFor(async () => {
    const value = await tunnel()
    return value.status === 'running' ? value : null
  })
  assert.equal(state.url, 'https://tunnel-test-abc.trycloudflare.com')
  assert.ok(state.pid > 0)
  assert.ok(state.logs.some(row => row.text.includes('trycloudflare.com')))
  assert.ok(fs.readFileSync(logFile, 'utf8').includes('trycloudflare.com'))
  assert.equal(JSON.stringify(state).includes(TOKEN), false)

  // 停用: 子进程收掉, 状态归零
  assert.equal((await configure({ enabled: false })).status, 200)
  state = await waitFor(async () => {
    const value = await tunnel()
    return value.status === 'stopped' && value.pid === 0 ? value : null
  })
  assert.equal(state.enabled, false)

  // 崩溃自动重启: 换成会退出的 fake, restartCount 递增
  assert.equal((await configure({ enabled: true, binary: process.execPath, extraArgs: [fakeCrash] })).status, 200)
  state = await waitFor(async () => {
    const value = await tunnel()
    return value.restartCount > 0 ? value : null
  }, 12_000)
  assert.ok(state.restartCount >= 1)
  assert.ok(state.logs.some(row => row.text.includes('退出') || row.text.includes('重启')))

  // 关闭, 避免测试结束仍留子进程
  await configure({ enabled: false })
})
