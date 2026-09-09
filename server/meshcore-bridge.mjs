import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const PORT = Number(process.env.MESHCORE_BRIDGE_PORT || 8765)

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

function encodeFrame(payload, opcode) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const len = data.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[0] = 0x80 | opcode
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, data])
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

function sendJson(socket, obj) {
  socket.write(encodeFrame(JSON.stringify(obj), 1))
}

function attachSocket(socket) {
  let buf = Buffer.alloc(0)
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

  socket.on('data', (chunk) => {
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
        socket.write(encodeFrame(frame.payload, 10))
        continue
      }
      if (frame.opcode !== 1 && frame.opcode !== 2) continue
      if (!opened) {
        if (frame.opcode !== 1) {
          sendJson(socket, { error: 'Send the radio IP as JSON first' })
          closeAll()
          return
        }
        let spec
        try {
          spec = JSON.parse(frame.payload.toString('utf8'))
        } catch {
          sendJson(socket, { error: 'Invalid JSON' })
          closeAll()
          return
        }
        const host = String(spec.host || '').trim()
        const port = Number(spec.port)
        if (!isAllowedTarget(host, port)) {
          sendJson(socket, {
            error:
              'Only private IPv4 addresses are allowed (192.168/10/172.16–31), as numbers not names.',
          })
          closeAll()
          return
        }
        opened = true
        tcp = net.connect({ host, port, timeout: 8000 })
        tcp.on('connect', () => {
          tcp.setTimeout(0)
          sendJson(socket, { ok: true })
        })
        tcp.on('data', (data) => {
          socket.write(encodeFrame(data, 2))
        })
        tcp.on('error', (err) => {
          const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
          let message = err instanceof Error ? err.message : 'TCP connect failed'
          if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
            message = `The website host could not reach ${host}:${port}. That only works if the MeshCore radio is on the same network as this server. Use USB from this PC, or run the app on a machine on your LAN.`
          } else if (code === 'ECONNREFUSED') {
            message = `Nothing accepted TCP on ${host}:${port}. Check companion_radio_wifi is running and the port (default 5000).`
          }
          try {
            sendJson(socket, { error: message })
          } catch {
            /* ignore */
          }
          closeAll()
        })
        tcp.on('close', () => closeAll())
        continue
      }
      if (tcp && frame.opcode === 2) tcp.write(frame.payload)
    }
  })
  socket.on('error', closeAll)
  socket.on('close', closeAll)
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
    attachSocket(socket)
  })
}

const startedDirectly =
  process.argv.includes('--listen') ||
  (Boolean(process.argv[1]) &&
    path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]))

if (startedDirectly) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200)
    res.end('meshcore-bridge')
  })
  attachMeshcoreBridge(server)
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`meshcore-bridge ws on ${PORT}`)
  })
}
