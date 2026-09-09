import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const PORT = Number(process.env.MESHCORE_BRIDGE_PORT || 8765)
const waiting = new Map()

export function isAllowedTarget(host, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host).trim())
  if (!m) return false
  const oct = m.slice(1).map(Number)
  if (oct.some((n) => n > 255)) return false
  const [a, b] = oct
  if (a === 10) return true
  if (a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64')
}

function encodeFrame(payload, opcode, masked = false) {
  const data = Buffer.isBuffer(payload) ? Buffer.from(payload) : Buffer.from(payload)
  const len = data.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[0] = 0x80 | opcode
    header[1] = (masked ? 0x80 : 0) | len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = (masked ? 0x80 : 0) | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = (masked ? 0x80 : 0) | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  if (!masked) return Buffer.concat([header, data])
  const mask = crypto.randomBytes(4)
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]
  return Buffer.concat([header, mask, data])
}

function decodeFrames(buf) {
  const frames = []
  let offset = 0
  while (buf.length - offset >= 2) {
    const b0 = buf[offset]
    const b1 = buf[offset + 1]
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let hdr = 2
    if (len === 126) {
      if (buf.length - offset < 4) break
      len = buf.readUInt16BE(offset + 2)
      hdr = 4
    } else if (len === 127) {
      if (buf.length - offset < 10) break
      const big = buf.readBigUInt64BE(offset + 2)
      if (big > 1024n * 1024n) throw new Error('frame too large')
      len = Number(big)
      hdr = 10
    }
    const maskLen = masked ? 4 : 0
    if (buf.length - offset < hdr + maskLen + len) break
    let payload = buf.subarray(offset + hdr + maskLen, offset + hdr + maskLen + len)
    if (masked) {
      const mask = buf.subarray(offset + hdr, offset + hdr + 4)
      const copy = Buffer.from(payload)
      for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i % 4]
      payload = copy
    }
    frames.push({ opcode, payload })
    offset += hdr + maskLen + len
  }
  return { frames, rest: buf.subarray(offset) }
}

function sendJson(socket, obj, masked = false) {
  socket.write(encodeFrame(JSON.stringify(obj), 1, masked))
}

function tcpErrorMessage(host, port, err, fromPc) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return fromPc
      ? `This PC could not reach ${host}:${port}. Check the IP, that companion_radio_wifi is on, and that this PowerShell window is running on the same LAN as the radio.`
      : `The website server could not reach ${host}:${port}. The radio is on your home network; this public site cannot open that IP. Use USB, or the PC helper shown in the panel.`
  }
  if (code === 'ECONNREFUSED') {
    return `Nothing accepted TCP on ${host}:${port}. Check companion_radio_wifi is running and the port (default 5000).`
  }
  return err instanceof Error ? err.message : 'TCP connect failed'
}

function startTcpBridge(socket, { masked = false, fromPc = false, firstSpec = null, initialBuf = null } = {}) {
  let buf = initialBuf && initialBuf.length ? Buffer.from(initialBuf) : Buffer.alloc(0)
  let tcp = null
  let opened = false

  const closeAll = () => {
    try {
      tcp?.destroy()
    } catch {
      /* ignore */
    }
    try {
      socket.destroy()
    } catch {
      /* ignore */
    }
  }

  const openTcp = (spec) => {
    const host = String(spec.host || '').trim()
    const port = Number(spec.port)
    if (!isAllowedTarget(host, port)) {
      sendJson(
        socket,
        {
          error:
            'Only private IPv4 addresses are allowed (192.168/10/172.16–31), as numbers not names.',
        },
        masked,
      )
      closeAll()
      return
    }
    opened = true
    tcp = net.connect({ host, port })
    tcp.setTimeout(8000)
    tcp.on('connect', () => {
      tcp.setTimeout(0)
      sendJson(socket, { ok: true }, masked)
    })
    tcp.on('timeout', () => {
      const err = new Error('timeout')
      err.code = 'ETIMEDOUT'
      tcp.destroy()
      try {
        sendJson(socket, { error: tcpErrorMessage(host, port, err, fromPc) }, masked)
      } catch {
        /* ignore */
      }
      closeAll()
    })
    tcp.on('data', (data) => {
      socket.write(encodeFrame(data, 2, masked))
    })
    tcp.on('error', (err) => {
      try {
        sendJson(socket, { error: tcpErrorMessage(host, port, err, fromPc) }, masked)
      } catch {
        /* ignore */
      }
      closeAll()
    })
    tcp.on('close', () => closeAll())
  }

  if (firstSpec) openTcp(firstSpec)

  const onChunk = (chunk) => {
    buf = Buffer.concat([buf, chunk])
    let frames
    try {
      const decoded = decodeFrames(buf)
      frames = decoded.frames
      buf = decoded.rest
    } catch {
      closeAll()
      return
    }
    for (const frame of frames) {
      if (frame.opcode === 8) {
        closeAll()
        return
      }
      if (frame.opcode === 9) {
        socket.write(encodeFrame(frame.payload, 10, masked))
        continue
      }
      if (frame.opcode !== 1 && frame.opcode !== 2) continue
      if (!opened) {
        if (frame.opcode !== 1) {
          sendJson(socket, { error: 'Send the radio IP as JSON first' }, masked)
          closeAll()
          return
        }
        let spec
        try {
          spec = JSON.parse(frame.payload.toString('utf8'))
        } catch {
          sendJson(socket, { error: 'Invalid JSON' }, masked)
          closeAll()
          return
        }
        openTcp(spec)
        continue
      }
      if (tcp && frame.opcode === 2) tcp.write(frame.payload)
    }
  }

  socket.on('data', onChunk)
  socket.on('error', closeAll)
  socket.on('close', closeAll)
  if (buf.length) onChunk(Buffer.alloc(0))
}

function bindRelay(a, b) {
  const pump = (from, to) => {
    let buf = Buffer.alloc(0)
    from.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      try {
        const decoded = decodeFrames(buf)
        buf = decoded.rest
        for (const frame of decoded.frames) {
          if (frame.opcode === 8) {
            from.destroy()
            to.destroy()
            return
          }
          to.write(encodeFrame(frame.payload, frame.opcode))
        }
      } catch {
        from.destroy()
        to.destroy()
      }
    })
    from.on('close', () => to.destroy())
    from.on('error', () => to.destroy())
  }
  pump(a, b)
  pump(b, a)
}

function handleClient(socket) {
  let buf = Buffer.alloc(0)
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk])
    let decoded
    try {
      decoded = decodeFrames(buf)
    } catch {
      socket.destroy()
      return
    }
    buf = decoded.rest
    for (const frame of decoded.frames) {
      if (frame.opcode === 8) {
        socket.destroy()
        return
      }
      if (frame.opcode !== 1) continue
      let msg
      try {
        msg = JSON.parse(frame.payload.toString('utf8'))
      } catch {
        sendJson(socket, { error: 'Invalid JSON' })
        socket.destroy()
        return
      }
      socket.off('data', onData)
      if (buf.length) socket.unshift(buf)

      if (msg.role === 'browser') {
        const session = crypto.randomBytes(16).toString('hex')
        const timer = setTimeout(() => {
          waiting.delete(session)
          try {
            sendJson(socket, { error: 'Timed out waiting for the helper on your PC.' })
          } catch {
            /* ignore */
          }
          socket.destroy()
        }, 180000)
        waiting.set(session, { browser: socket, timer })
        socket.on('close', () => {
          const w = waiting.get(session)
          if (w?.browser === socket) {
            clearTimeout(w.timer)
            waiting.delete(session)
          }
        })
        sendJson(socket, { session })
        return
      }

      if (msg.role === 'agent') {
        const session = String(msg.session || '')
        const w = waiting.get(session)
        if (!w) {
          sendJson(socket, { error: 'Unknown or expired helper session. Click Connect IP again.' })
          socket.destroy()
          return
        }
        clearTimeout(w.timer)
        waiting.delete(session)
        bindRelay(w.browser, socket)
        sendJson(w.browser, { agentReady: true })
        return
      }

      startTcpBridge(socket, { firstSpec: msg, fromPc: false, initialBuf: buf })
      return
    }
  }
  socket.on('data', onData)
  socket.on('error', () => socket.destroy())
}

export function attachMeshcoreBridge(httpServer) {
  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url || ''
    if (!url.startsWith('/meshcore-bridge')) return
    const key = req.headers['sec-websocket-key']
    if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.destroy()
      return
    }
    const accept = wsAccept(Array.isArray(key) ? key[0] : key)
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n',
    )
    if (head && head.length) socket.unshift(head)
    handleClient(socket)
  })
}

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? String(process.argv[i + 1] || '') : ''
}

async function connectWsClient(urlStr) {
  const u = new URL(urlStr)
  const isTls = u.protocol === 'wss:'
  const port = Number(u.port || (isTls ? 443 : 80))
  const socket = await new Promise((resolve, reject) => {
    const onErr = (err) => reject(err)
    const s = isTls
      ? tls.connect({ host: u.hostname, port, servername: u.hostname }, () => {
          s.off('error', onErr)
          resolve(s)
        })
      : net.connect({ host: u.hostname, port }, () => {
          s.off('error', onErr)
          resolve(s)
        })
    s.on('error', onErr)
  })
  const key = crypto.randomBytes(16).toString('base64')
  const reqPath = `${u.pathname || '/meshcore-bridge'}${u.search}`
  await new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0)
    const onData = (chunk) => {
      acc = Buffer.concat([acc, chunk])
      const idx = acc.indexOf('\r\n\r\n')
      if (idx < 0) return
      socket.off('data', onData)
      const head = acc.subarray(0, idx).toString('utf8')
      const rest = acc.subarray(idx + 4)
      if (!/^HTTP\/1\.\d 101/i.test(head)) {
        reject(new Error(head.split('\r\n')[0] || 'WebSocket upgrade failed'))
        return
      }
      if (rest.length) socket.unshift(rest)
      resolve()
    }
    socket.on('data', onData)
    socket.on('error', reject)
    socket.write(
      `GET ${reqPath} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        '\r\n',
    )
  })
  return socket
}

async function runAgent(url, session) {
  const socket = await connectWsClient(url)
  sendJson(socket, { role: 'agent', session }, true)
  startTcpBridge(socket, { masked: true, fromPc: true })
  console.log('meshcore PC helper connected; waiting for the browser to send the radio IP')
  await new Promise((resolve) => socket.on('close', resolve))
}

const startedDirectly =
  process.argv.includes('--listen') ||
  process.argv.includes('--agent') ||
  (Boolean(process.argv[1]) &&
    path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]))

if (startedDirectly && process.argv.includes('--agent')) {
  const session = argValue('--session')
  const url = argValue('--url')
  if (!session || !url) {
    console.error('Usage: node meshcore-bridge.mjs --agent --session <id> --url wss://host/meshcore-bridge')
    process.exit(1)
  }
  runAgent(url, session).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
} else if (startedDirectly) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200)
    res.end('meshcore-bridge')
  })
  attachMeshcoreBridge(server)
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`meshcore-bridge ws on ${PORT}`)
  })
}
