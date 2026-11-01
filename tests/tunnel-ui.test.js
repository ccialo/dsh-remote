'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')

test('管理页包含 Cloudflare 隧道卡片与双语文案', () => {
  const html = read('public/admin.html')
  const js = read('public/admin.js')

  const ids = [
    'tunnel-card', 'tunnel-summary', 'tunnel-badge',
    'btn-tunnel-toggle', 'btn-tunnel-restart',
    'tunnel-url-row', 'tunnel-url', 'btn-tunnel-copy', 'btn-tunnel-qr',
    'tunnel-qr-box', 'tunnel-qr', 'tunnel-qr-hint',
    'tunnel-config', 'tunnel-mode', 'tunnel-hostname', 'tunnel-name',
    'tunnel-token', 'tunnel-binary', 'tunnel-protocol', 'tunnel-config-hint',
    'btn-tunnel-save', 'tunnel-log', 'tunnel-log-pause', 'btn-tunnel-log-clear',
  ]
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `admin.html missing #${id}`)

  // 中文与英文各一份 tunnel.* 文案
  const zhIndex = html.indexOf("tunnel.title")
  const enIndex = html.lastIndexOf("tunnel.title")
  assert.ok(zhIndex > 0, 'missing zh tunnel strings')
  assert.ok(enIndex > zhIndex, 'missing en tunnel strings')
  for (const key of ['tunnel.mode.quick', 'tunnel.mode.named', 'tunnel.status.running', 'tunnel.log', 'tunnel.save']) {
    assert.equal(html.split(`'${key}'`).length - 1, 2, `${key} must exist in zh and en`)
  }

  // 前端确实调用隧道接口并使用 dshremote:// 配对
  assert.ok(js.includes('/tunnel/config'), 'admin.js should post tunnel config')
  assert.ok(js.includes('/tunnel/restart'), 'admin.js should restart the tunnel')
  assert.ok(js.includes('dshremote://pair'), 'admin.js should render a pairing QR for the tunnel URL')
})

test('插件包内的 gateway.cjs 与 public 产物和根目录保持同步', () => {
  assert.equal(read('packages/plugin/gateway.cjs'), read('gateway.js'), 'run npm run sync-plugin')
  assert.equal(read('packages/plugin/public/admin.html'), read('public/admin.html'), 'run npm run sync-plugin')
  assert.equal(read('packages/plugin/public/admin.js'), read('public/admin.js'), 'run npm run sync-plugin')
})
