import type { ExistingNode } from '../types'

const APP_TO_RADIO = 0x3c
const RADIO_TO_APP = 0x3e
const CMD_APP_START = 1
const CMD_GET_CONTACTS = 4
const CMD_DEVICE_QUERY = 22
const RESP_CONTACTS_START = 2
const RESP_CONTACT = 3
const RESP_END_OF_CONTACTS = 4
const RESP_ERR = 1
const ADV_REPEATER = 2
const ADV_ROOM = 3
const PROTOCOL_VER = 3

export type MeshTransport = {
  write: (bytes: Uint8Array) => Promise<void>
  close: () => Promise<void>
}

type FrameHandler = (payload: Uint8Array) => void

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function readCString(buf: Uint8Array, start: number, len: number): string {
  let end = start
  const max = Math.min(buf.length, start + len)
  while (end < max && buf[end] !== 0) end++
  return new TextDecoder().decode(buf.subarray(start, end)).trim()
}

function i32le(view: DataView, offset: number): number {
  return view.getInt32(offset, true)
}

function frameAppToRadio(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(3 + payload.length)
  out[0] = APP_TO_RADIO
  out[1] = payload.length & 0xff
  out[2] = (payload.length >> 8) & 0xff
  out.set(payload, 3)
  return out
}

export function pushSerialBytes(buffer: Uint8Array, chunk: Uint8Array, onFrame: FrameHandler): Uint8Array {
  let buf = concat(buffer, chunk)
  while (buf.length >= 3) {
    const type = buf[0]
    if (type !== RADIO_TO_APP && type !== APP_TO_RADIO) {
      buf = buf.subarray(1)
      continue
    }
    const len = buf[1] | (buf[2] << 8)
    if (len === 0) {
      buf = buf.subarray(1)
      continue
    }
    if (buf.length < 3 + len) break
    onFrame(buf.subarray(3, 3 + len))
    buf = buf.subarray(3 + len)
  }
  return buf
}

function parseContact(payload: Uint8Array): {
  type: number
  name: string
  lat: number
  lon: number
} | null {
  if (payload.length < 1 + 32 + 1 + 1 + 1 + 64 + 32 + 4 + 4 + 4 + 4) return null
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  let o = 1
  o += 32
  const type = payload[o]
  o += 1
  o += 1
  o += 1
  o += 64
  const name = readCString(payload, o, 32)
  o += 32
  o += 4
  const latRaw = i32le(view, o)
  o += 4
  const lonRaw = i32le(view, o)
  return {
    type,
    name,
    lat: latRaw / 1_000_000,
    lon: lonRaw / 1_000_000,
  }
}

function hasFix(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
  if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) return false
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180
}

export function contactsToRepeaters(
  contacts: { type: number; name: string; lat: number; lon: number }[],
): ExistingNode[] {
  const nodes: ExistingNode[] = []
  for (const c of contacts) {
    if (c.type !== ADV_REPEATER && c.type !== ADV_ROOM) continue
    if (!hasFix(c.lat, c.lon)) continue
    nodes.push({
      id: `mesh-${nodes.length + 1}`,
      lat: c.lat,
      lon: c.lon,
      name: c.name || (c.type === ADV_ROOM ? `Room ${nodes.length + 1}` : `Repeater ${nodes.length + 1}`),
      kind: c.type === ADV_ROOM ? 'room' : 'repeater',
    })
  }
  return nodes
}

export class MeshCoreSession {
  private buf: Uint8Array = new Uint8Array(0)
  private waiters: Array<(frame: Uint8Array) => void> = []
  private transport: MeshTransport

  constructor(transport: MeshTransport) {
    this.transport = transport
  }

  ingest(chunk: Uint8Array): void {
    this.buf = pushSerialBytes(this.buf, chunk, (frame) => {
      const waiter = this.waiters.shift()
      if (waiter) waiter(frame)
    }) as Uint8Array
  }

  private waitFrame(ms: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const i = this.waiters.indexOf(onFrame)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new Error('Timed out waiting for the MeshCore radio'))
      }, ms)
      const onFrame = (frame: Uint8Array) => {
        window.clearTimeout(timer)
        resolve(frame)
      }
      this.waiters.push(onFrame)
    })
  }

  private async send(payload: Uint8Array): Promise<void> {
    await this.transport.write(frameAppToRadio(payload))
  }

  async handshake(): Promise<void> {
    await this.send(Uint8Array.of(CMD_DEVICE_QUERY, PROTOCOL_VER))
    try {
      await this.waitFrame(2500)
    } catch {
      // Older firmware may not answer device-query; continue.
    }
    const name = new TextEncoder().encode('SignalMap')
    const start = new Uint8Array(2 + 6 + name.length)
    start[0] = CMD_APP_START
    start[1] = 1
    start.set(name, 8)
    await this.send(start)
    try {
      await this.waitFrame(2500)
    } catch {
      // Some radios still accept GET_CONTACTS after a quiet app-start.
    }
  }

  async getRepeaterContacts(): Promise<ExistingNode[]> {
    const contacts: { type: number; name: string; lat: number; lon: number }[] = []
    await this.send(Uint8Array.of(CMD_GET_CONTACTS))
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const frame = await this.waitFrame(Math.max(500, deadline - Date.now()))
      const code = frame[0]
      if (code === RESP_ERR) throw new Error('Radio returned an error while listing contacts')
      if (code === RESP_CONTACTS_START) continue
      if (code === RESP_CONTACT) {
        const parsed = parseContact(frame)
        if (parsed) contacts.push(parsed)
        continue
      }
      if (code === RESP_END_OF_CONTACTS) break
    }
    return contactsToRepeaters(contacts)
  }

  async close(): Promise<void> {
    await this.transport.close()
  }
}

function serialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator
}

export async function importRepeatersOverUsb(): Promise<ExistingNode[]> {
  if (!serialSupported()) {
    throw new Error('USB needs Chrome or Edge with Web Serial. Firefox and Safari cannot talk to the radio from this page.')
  }
  const nav = navigator as Navigator & {
    serial: {
      requestPort: () => Promise<{
        open: (opts: { baudRate: number }) => Promise<void>
        close: () => Promise<void>
        readable: ReadableStream<Uint8Array> | null
        writable: WritableStream<Uint8Array> | null
      }>
    }
  }
  const port = await nav.serial.requestPort()
  await port.open({ baudRate: 115200 })
  const reader = port.readable?.getReader()
  const writable = port.writable
  if (!reader || !writable) {
    await port.close()
    throw new Error('Serial port opened but has no reader/writer')
  }
  const session = new MeshCoreSession({
    write: async (bytes) => {
      const writer = writable.getWriter()
      try {
        await writer.write(bytes)
      } finally {
        writer.releaseLock()
      }
    },
    close: async () => {
      try {
        reader.releaseLock()
      } catch {
        /* ignore */
      }
      try {
        await port.close()
      } catch {
        /* ignore */
      }
    },
  })
  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) session.ingest(value)
      }
    } catch {
      /* port closed */
    }
  })()
  try {
    await session.handshake()
    return await session.getRepeaterContacts()
  } finally {
    await session.close()
    await pump.catch(() => undefined)
  }
}

type TcpOpened = {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  close: () => Promise<void>
}

async function openDirectTcp(host: string, port: number): Promise<TcpOpened | null> {
  const g = globalThis as typeof globalThis & {
    TCPSocket?: new (
      addr: string,
      p: number,
    ) => { opened: Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }>; close: () => Promise<void> }
  }
  if (!g.TCPSocket) return null
  const sock = new g.TCPSocket(host, port)
  const opened = await sock.opened
  return {
    readable: opened.readable,
    writable: opened.writable,
    close: () => sock.close(),
  }
}

async function runSessionOnTcp(tcp: TcpOpened): Promise<ExistingNode[]> {
  const reader = tcp.readable.getReader()
  const session = new MeshCoreSession({
    write: async (bytes) => {
      const writer = tcp.writable.getWriter()
      try {
        await writer.write(bytes)
      } finally {
        writer.releaseLock()
      }
    },
    close: async () => {
      try {
        reader.releaseLock()
      } catch {
        /* ignore */
      }
      await tcp.close()
    },
  })
  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) session.ingest(value)
      }
    } catch {
      /* closed */
    }
  })()
  try {
    await session.handshake()
    return await session.getRepeaterContacts()
  } finally {
    await session.close()
    await pump.catch(() => undefined)
  }
}

async function openSiteTcpBridge(host: string, port: number): Promise<TcpOpened> {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${proto}//${window.location.host}/meshcore-bridge`)
  ws.binaryType = 'arraybuffer'
  const incoming = new TransformStream<Uint8Array, Uint8Array>()
  const inWriter = incoming.writable.getWriter()

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      ws.close()
      reject(new Error('Timed out connecting through this site to the radio'))
    }, 15000)
    ws.addEventListener('error', () => {
      window.clearTimeout(timer)
      reject(
        new Error(
          'Could not open the MeshCore TCP helper on this site. Try USB, or hard-refresh after a server update.',
        ),
      )
    })
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ host, port }))
    })
    ws.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        let msg: { ok?: boolean; error?: string }
        try {
          msg = JSON.parse(event.data) as { ok?: boolean; error?: string }
        } catch {
          return
        }
        if (msg.error) {
          window.clearTimeout(timer)
          ws.close()
          reject(new Error(msg.error))
          return
        }
        if (msg.ok) {
          window.clearTimeout(timer)
          resolve()
        }
        return
      }
      void inWriter.write(new Uint8Array(event.data as ArrayBuffer))
    })
    ws.addEventListener('close', () => {
      void inWriter.close()
    })
  })

  return {
    readable: incoming.readable,
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        if (ws.readyState !== WebSocket.OPEN) throw new Error('Radio connection closed')
        ws.send(chunk.slice())
      },
      close() {
        ws.close()
      },
    }),
    close: async () => {
      ws.close()
    },
  }
}

export async function importRepeatersOverIp(host: string, port: number): Promise<ExistingNode[]> {
  const h = host.trim()
  const p = Math.min(65535, Math.max(1, Math.round(port) || 5000))
  if (!h) throw new Error('Enter the radio IP address')
  const tcp = (await openDirectTcp(h, p)) ?? (await openSiteTcpBridge(h, p))
  return runSessionOnTcp(tcp)
}
