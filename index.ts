import express, { type Request, type Response, type NextFunction } from "express"
import { Client, RemoteAuth, MessageMedia } from "whatsapp-web.js"
import cors from "cors"
import qrcode from "qrcode"
import multer from "multer"
import * as nodeCrypto from "node:crypto"
import { existsSync, readFileSync, writeFileSync, rmSync } from "fs"
import { spawnSync } from "child_process"
import { hostname } from "os"
import { join } from "path"
import { Pool } from "pg"

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function initDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      session_id   VARCHAR(255) PRIMARY KEY,
      session_data TEXT         NOT NULL,
      updated_at   TIMESTAMP    NOT NULL DEFAULT NOW()
    )
  `)
  console.log(`[${ts()}] [DB] Tabela whatsapp_sessions verificada/criada`)
}

// Store implementando a interface do RemoteAuth
class PostgreSQLStore {
  async sessionExists({ session }: { session: string }): Promise<boolean> {
    const { rows } = await pool.query(
      'SELECT 1 FROM whatsapp_sessions WHERE session_id = $1',
      [session]
    )
    return rows.length > 0
  }

  async save({ session }: { session: string }): Promise<void> {
    const zipPath = join(process.cwd(), `${session}.zip`)
    const data = readFileSync(zipPath).toString('base64')
    await pool.query(`
      INSERT INTO whatsapp_sessions (session_id, session_data, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (session_id) DO UPDATE
        SET session_data = EXCLUDED.session_data, updated_at = NOW()
    `, [session, data])
  }

  async extract({ session, path: targetPath }: { session: string; path: string }): Promise<void> {
    const { rows } = await pool.query(
      'SELECT session_data FROM whatsapp_sessions WHERE session_id = $1',
      [session]
    )
    if (rows.length === 0) return
    writeFileSync(join(targetPath, `${session}.zip`), Buffer.from(rows[0].session_data, 'base64'))
  }

  async delete({ session }: { session: string }): Promise<void> {
    await pool.query('DELETE FROM whatsapp_sessions WHERE session_id = $1', [session])
  }
}

async function loadPersistedSessions(): Promise<string[]> {
  try {
    const { rows } = await pool.query('SELECT session_id FROM whatsapp_sessions')
    // session_id é 'RemoteAuth-gabriel_ferreira' → extrai só o userId
    return rows.map((r: { session_id: string }) => r.session_id.replace(/^RemoteAuth-/, ''))
  } catch (e: any) {
    console.error(`[${ts()}] [DB] Erro ao carregar sessões persistidas:`, e?.message)
    return []
  }
}

const app = express()
app.use(cors())
app.use(express.json())

// Log de cada requisição HTTP com método, rota, status e duração
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now()
  res.on('finish', () => {
    const ms = Date.now() - start
    const line = `[${ts()}] [HTTP] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`
    if (res.statusCode >= 500) console.error(line)
    else if (res.statusCode >= 400) console.warn(line)
    else console.log(line)
  })
  next()
})

const API_KEY = process.env.API_KEY ?? ''
if (!API_KEY) {
  console.warn('[SEGURANÇA] API_KEY não configurada — servidor acessível sem autenticação. Defina API_KEY nas variáveis de ambiente.')
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY) return next()
  const auth = req.headers.authorization
  if (!auth || auth !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized', details: 'API key inválida ou ausente. Envie o header: Authorization: Bearer <sua-chave>' })
  }
  next()
}

app.use('/instance', authMiddleware)
app.use('/message', authMiddleware)
app.use('/messages', authMiddleware)
app.use('/ia', authMiddleware)

type MediaLog = {
  mimetype: string
  filename: string
  data?: string
}

type MessageLog = {
  messageId: string
  userId: string
  instanceId: string
  number: string
  name: string
  body: string
  type: string
  direction: 'sent' | 'received'
  timestamp: Date
  media: MediaLog | null
  whatsappMessageId: string
}

type RegistryPayload = Record<string, unknown>

type QueueItem = {
  number: string
  message: string
  messageId: string
  media?: { base64: string; mimetype: string; filename: string; ptt?: boolean }
  resolve: (value: SendResult) => void
  reject: (reason?: unknown) => void
}

type SendResult = {
  success: boolean
  messageId: string
  message: string
  whatsappMessageId: string
}

type SessionData = {
  client: Client
  qrCode: string | null
  ready: boolean
  authenticated: boolean
  lastKnownState: string | null
  lastError: string | null
  userId: string
  instanceId: string
  logs: MessageLog[]
  createdAt: Date
  readyAt: Date | null            // quando o evento ready disparou pela última vez
  destroyingIntentionally: boolean // true quando desconexão é via API ou shutdown
  sentMessages: number
  receivedMessages: number
  apiCalls: number
  number?: string
}

function generateUniqueId() {
  return nodeCrypto.randomUUID()
}

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23)
}

const ACK_LABELS: Record<number, string> = {
  0: 'pendente', 1: 'enviada', 2: 'entregue', 3: 'lida', 4: 'reproduzida',
}

const activeClients  = new Map<string, SessionData>()
const pausedNumbers  = new Map<string, Set<string>>()
const messageQueues  = new Map<string, QueueItem[]>()
const isSendingMessage = new Map<string, boolean>()
const messageRegistry  = new Map<string, RegistryPayload>()

const MAX_REGISTRY_SIZE      = 5000
const MAX_SESSION_LOGS       = 200
const WHATSAPP_MEDIA_LIMIT_MB = 16
const SEND_TIMEOUT_MS        = 60_000
const READY_WARMUP_MS        = 5_000  // warm-up após ready antes de aceitar envios

const ALLOWED_IMAGE_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const ALLOWED_AUDIO_MIMETYPES = new Set([
  'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/mp4',
  'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/aac', 'audio/webm',
])
const IGNORED_WEBHOOK_TYPES = new Set([
  'notification_template', 'notification', 'e2e_notification', 'call_log', 'protocol',
])


const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: WHATSAPP_MEDIA_LIMIT_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIMETYPES.has(file.mimetype)) cb(null, true)
    else cb(new Error(`Tipo não suportado: ${file.mimetype}. Use JPEG, PNG, GIF ou WebP.`))
  },
})

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: WHATSAPP_MEDIA_LIMIT_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const baseMime = file.mimetype.split(';')[0].trim()
    if (ALLOWED_AUDIO_MIMETYPES.has(baseMime)) cb(null, true)
    else cb(new Error(`Tipo não suportado: ${file.mimetype}. Use OGG, MP3, WAV, MP4 ou AAC.`))
  },
})

function cappedMapSet<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  map.set(key, value)
  if (map.size > maxSize) map.delete(map.keys().next().value as K)
}

function getParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

function computeSessionStatus(session: SessionData): 'ready' | 'qr_pending' | 'initializing' | 'disconnected' {
  if (session.ready) return 'ready'
  if (session.qrCode) return 'qr_pending'
  if (session.lastKnownState === 'DISCONNECTED') return 'disconnected'
  return 'initializing'
}

function isInWarmup(session: SessionData): boolean {
  return session.readyAt !== null && Date.now() - session.readyAt.getTime() < READY_WARMUP_MS
}

function isWidFactoryError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('WidFactory')
}

async function syncSessionReadiness(session: SessionData): Promise<string | null> {
  try {
    const state = await session.client.getState().catch(() => null)
    session.lastKnownState = state
    if (state === 'CONNECTED') {
      session.ready = true
      session.authenticated = true
    } else if (state !== null) {
      session.ready = false
    }
    return state
  } catch (err) {
    session.lastError = err instanceof Error ? err.message : String(err)
    return null
  }
}

// ─── /instance/create ────────────────────────────────────────────────────────

function createSession(userId: string): void {
  if (activeClients.has(userId)) return

  const instanceId = generateUniqueId()
  console.log(`[${ts()}] [${userId}] Criando nova sessão (instanceId: ${instanceId})...`)

  const client = new Client({
    authStrategy: new RemoteAuth({
      clientId: userId,
      dataPath: '/tmp/wwebjs',
      store: new PostgreSQLStore(),
      backupSyncIntervalMs: 300_000,
    }),
    puppeteer: {
      executablePath: '/usr/bin/chromium',
      headless: true,
      args: [
        // Segurança / Docker obrigatório
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-zygote',
        '--single-process',

        // GPU / renderização (não usados em headless)
        '--disable-gpu',
        '--disable-accelerated-2d-canvas',
        '--disable-software-rasterizer',

        // Subsistemas desnecessários para WhatsApp Web
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-client-side-phishing-detection',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-features=TranslateUI,Translate',
        '--disable-ipc-flooding-protection',

        // Cache mínimo (reduz uso de disco e memória mapeada)
        '--disk-cache-size=1',
        '--media-cache-size=1',
      ],
    },
  })

  const sessionData: SessionData = {
    client,
    qrCode: null,
    ready: false,
    authenticated: false,
    lastKnownState: null,
    lastError: null,
    userId,
    instanceId,
    logs: [],
    createdAt: new Date(),
    readyAt: null,
    destroyingIntentionally: false,
    sentMessages: 0,
    receivedMessages: 0,
    apiCalls: 0,
  }

  let readyCount = 0
  let destroyingDueToLoop = false
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let lastReadyAt = 0
  let lastAuthenticatedAt = 0

  client.on('qr', (qr: string) => {
    qrcode.toDataURL(qr, (err: Error | null | undefined, url: string) => {
      if (err) { console.error(`[${ts()}] [${userId}] [QR] Erro ao gerar QR:`, err); return }
      sessionData.qrCode = url
      console.log(`[${ts()}] [${userId}] [QR] QR gerado, aguardando scan`)
    })
  })

  client.on('ready', () => {
    const now = Date.now()
    if (now - lastReadyAt < 5_000) {
      console.log(`[${ts()}] [${userId}] [READY] Evento duplicado ignorado (${now - lastReadyAt}ms desde o último)`)
      return
    }
    lastReadyAt = now
    readyCount++

    if (readyCount > 5) {
      if (!destroyingDueToLoop) {
        destroyingDueToLoop = true
        console.error(`[${ts()}] [${userId}] [LOOP] Loop de inicialização detectado (ready #${readyCount}) — encerrando sessão para proteger o número`)
        sessionData.ready = false
        sessionData.authenticated = false
        sessionData.lastKnownState = 'DISCONNECTED'
        sessionData.lastError = `Loop detectado após ${readyCount} eventos ready. Reinicie via /instance/disconnect/${userId} e /instance/create/${userId}.`
        client.destroy().catch(() => {})
      }
      return
    }

    const uptimeSec = Math.round((Date.now() - sessionData.createdAt.getTime()) / 1000)
    sessionData.ready = true
    sessionData.authenticated = true
    sessionData.lastKnownState = 'CONNECTED'
    sessionData.lastError = null
    sessionData.readyAt = new Date()
    sessionData.number = client.info.wid.user

    // Heartbeat a cada 30s para evitar desconexão por inatividade
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = setInterval(async () => {
      try { await client.getState() } catch {}
    }, 30_000)

    console.log(`[${ts()}] [${userId}] [READY] Instância pronta — número: ${sessionData.number} | ready #${readyCount} | uptime: ${uptimeSec}s`)
    processQueue(userId)
  })

  client.on('authenticated', () => {
    const now = Date.now()
    if (now - lastAuthenticatedAt < 5_000) {
      console.log(`[${ts()}] [${userId}] [AUTHENTICATED] Evento duplicado ignorado (${now - lastAuthenticatedAt}ms desde o último)`)
      return
    }
    lastAuthenticatedAt = now
    if (destroyingDueToLoop) return
    sessionData.authenticated = true
    sessionData.qrCode = null
    sessionData.lastError = null
    console.log(`[${ts()}] [${userId}] [AUTHENTICATED] Sessão autenticada`)
  })

  client.on('auth_failure', (message: string) => {
    sessionData.ready = false
    sessionData.authenticated = false
    sessionData.lastError = message || 'auth_failure'
    console.error(`[${ts()}] [${userId}] [AUTH_FAIL] Falha de autenticação: ${message}`)
  })

  client.on('change_state', (state: string) => {
    const prev = sessionData.lastKnownState ?? '?'
    sessionData.lastKnownState = state
    console.log(`[${ts()}] [${userId}] [STATE] ${prev} → ${state}`)
    if (state === 'CONNECTED') {
      sessionData.ready = true
      sessionData.authenticated = true
      processQueue(userId)
    }
    if (state === 'UNPAIRED' || state === 'UNPAIRED_IDLE' || state === 'DISCONNECTED') {
      sessionData.ready = false
    }
  })

  client.on('disconnected', async (reason: string) => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }

    sessionData.ready = false
    sessionData.authenticated = false
    sessionData.lastKnownState = 'DISCONNECTED'
    sessionData.lastError = reason || null
    sessionData.qrCode = null
    console.warn(`[${ts()}] [${userId}] [DISCONNECTED] Razão: ${reason || '(sem motivo)'}`)

    const queue = messageQueues.get(userId)
    if (queue && queue.length > 0) {
      const pending = queue.splice(0)
      console.warn(`[${ts()}] [${userId}] [DISCONNECTED] Fila drenada: ${pending.length} mensagem(ns) rejeitada(s)`)
      for (const item of pending) item.reject(new Error('Sessão desconectada. Tente novamente.'))
    }

    if (sessionData.destroyingIntentionally || destroyingDueToLoop) return

    console.log(`[${ts()}] [${userId}] [RECONNECT] Aguardando 5s para reinicializar...`)
    await new Promise<void>(r => setTimeout(r, 5000))

    if (!activeClients.has(userId) || sessionData.destroyingIntentionally) {
      console.log(`[${ts()}] [${userId}] [RECONNECT] Abortado — sessão removida durante a espera`)
      return
    }

    // Reseta contadores para que a reconexão automática não dispare a proteção de loop
    readyCount = 0
    destroyingDueToLoop = false
    sessionData.lastKnownState = null // mostra 'initializing' durante a reconexão

    try {
      await client.initialize()
      console.log(`[${ts()}] [${userId}] [RECONNECT] Reinicialização iniciada`)
    } catch (err) {
      console.error(`[${ts()}] [${userId}] [RECONNECT] Falha ao reinicializar:`, err)
    }
  })

  client.on('message_ack', async (msg: any, ack: number) => {
    if (ack < 2) return
    const senderwhatsUrl = process.env.SENDERWHATS_URL
    if (!senderwhatsUrl) return

    const messageId = msg.id._serialized
    const ackName = ACK_LABELS[ack] ?? `ack-${ack}`
    const msgShort = messageId.slice(-10)
    console.log(`[${ts()}] [${userId}] [ACK] ...${msgShort} → ${ackName}`)

    const webhookSecret = process.env.WEBHOOK_SECRET
    const t0 = Date.now()
    try {
      const res = await fetch(`${senderwhatsUrl}/api/webhooks/message-ack`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(webhookSecret ? { 'x-webhook-secret': webhookSecret } : {}),
        },
        body: JSON.stringify({ messageId, ack, userId }),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) console.warn(`[${ts()}] [${userId}] [ACK] webhook → ${res.status} para ...${msgShort} (${Date.now() - t0}ms)`)
      else console.log(`[${ts()}] [${userId}] [ACK] webhook → OK para ...${msgShort} (${Date.now() - t0}ms)`)
    } catch (err) {
      if (err instanceof Error && err.name !== 'TimeoutError' && err.name !== 'AbortError') {
        console.error(`[${ts()}] [${userId}] [ACK] webhook erro para ...${msgShort}:`, err.message)
      }
    }
  })

  client.on('message', async (msg: any) => {
    try {
      if (msg.from.endsWith('@g.us') || msg.from.endsWith('@newsletter') || IGNORED_WEBHOOK_TYPES.has(msg.type)) return

      sessionData.receivedMessages++
      const contact = await msg.getContact().catch(() => null)
      const contactName = contact?.pushname || contact?.name || contact?.number || msg.from
      const from = msg.from.endsWith('@lid')
        ? (contact?.number ?? msg.from.replace('@lid', ''))
        : msg.from.replace('@c.us', '')
      const rawBody = msg.body ?? ''
      const preview = rawBody.slice(0, 80).replace(/\n/g, ' ')
      const previewFmt = msg.type === 'ptt' ? '[ptt/áudio]'
        : rawBody.length > 0 ? `"${preview}${rawBody.length > 80 ? '...' : ''}"` : `[${msg.type}]`
      console.log(`[${ts()}] [${userId}] [MSG] ← de ${from} (${contactName}) ${previewFmt} | total: ${sessionData.receivedMessages}`)

      const messageId = generateUniqueId()
      cappedMapSet(messageRegistry, messageId, {
        userId, instanceId, timestamp: new Date(), type: 'received', whatsappMessageId: msg.id._serialized
      }, MAX_REGISTRY_SIZE)

      const log: MessageLog = {
        messageId, userId, instanceId, number: msg.from, name: contactName,
        body: msg.body, type: msg.type, direction: 'received',
        timestamp: new Date(), media: null, whatsappMessageId: msg.id._serialized,
      }

      if (msg.hasMedia && msg.type === 'ptt') {
        try {
          const media = await msg.downloadMedia()
          if (media) {
            log.media = { mimetype: media.mimetype, data: media.data, filename: `audio-${Date.now()}.ogg` }
            console.log(`[${ts()}] [${userId}] [MSG] PTT recebido de ${from} — download OK`)
          }
        } catch (err: any) {
          console.error(`[${ts()}] [${userId}] [MSG] Erro ao baixar PTT de ${from}: ${err?.message}`)
        }
      }

      sessionData.logs.push(log)
      if (sessionData.logs.length > MAX_SESSION_LOGS) sessionData.logs.shift()

      if (pausedNumbers.get(userId)?.has(msg.from)) {
        console.log(`[${ts()}] [${userId}] [MSG] IA pausada para ${from} — mensagem registrada`)
      }

      const webhookUrl = process.env.WEBHOOK_URL
      if (webhookUrl && !msg.fromMe) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 5000)
        const t0 = Date.now()
        try {
          const webhookSecret = process.env.WEBHOOK_SECRET
          const headers: Record<string, string> = { 'Content-Type': 'application/json' }
          if (webhookSecret) headers['Authorization'] = `Bearer ${webhookSecret}`
          const webhookRes = await fetch(webhookUrl, {
            method: 'POST', headers, signal: controller.signal,
            body: JSON.stringify({ userId, instanceId, from, body: rawBody, timestamp: msg.timestamp }),
          })
          const ms = Date.now() - t0
          if (!webhookRes.ok) console.error(`[${ts()}] [${userId}] [WEBHOOK] → ${webhookRes.status} (${ms}ms)`)
          else console.log(`[${ts()}] [${userId}] [WEBHOOK] → OK (${ms}ms)`)
        } catch (err: any) {
          console.error(`[${ts()}] [${userId}] [WEBHOOK] falhou (${Date.now() - t0}ms):`, err?.message ?? err)
        } finally {
          clearTimeout(timer)
        }
      }
    } catch (err: any) {
      console.error(`[${ts()}] [${userId}] [MSG] Erro ao processar mensagem recebida:`, err?.message ?? err)
    }
  })

  console.log(`[${ts()}] [${userId}] Lançando Chromium em /usr/bin/chromium...`)
  client.initialize()
  activeClients.set(userId, sessionData)
  console.log(`[${ts()}] [${userId}] client.initialize() chamado — aguardando QR ou autenticação automática`)
}

app.get('/instance/create/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)

  if (activeClients.has(userId)) {
    const existing = activeClients.get(userId)!
    console.log(`[${ts()}] [${userId}] Sessão já existe — ready=${existing.ready} state=${existing.lastKnownState ?? '?'}`)
    return res.status(200).json({
      message: 'Sessão já existe',
      status: 'existing',
      userId,
      instanceId: existing.instanceId,
      ready: existing.ready,
      authenticated: existing.authenticated,
      state: existing.lastKnownState,
    })
  }

  createSession(userId)
  const session = activeClients.get(userId)!
  res.status(200).json({ message: `Instância '${userId}' criada com sucesso.`, userId, instanceId: session.instanceId })
})

// ─── Logs / consultas ─────────────────────────────────────────────────────────

app.get('/messages/log/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const session = activeClients.get(userId)
  if (!session) return res.status(404).send('Sessão não encontrada.')
  session.apiCalls++

  const direction = getParam(req.query.direction as string | undefined)
  const number    = getParam(req.query.number as string | undefined).trim()
  const since     = getParam(req.query.since as string | undefined).trim()
  const sinceDate = since ? new Date(since) : null
  const sinceValid = sinceDate && !isNaN(sinceDate.getTime())

  let logs = direction === 'sent' || direction === 'received'
    ? session.logs.filter(l => l.direction === direction)
    : session.logs
  if (number) logs = logs.filter(l => l.number === number || l.number === `${number}@c.us`)
  if (sinceValid) logs = logs.filter(l => new Date(l.timestamp) > sinceDate!)

  res.json({ userId, instanceId: session.instanceId, total: logs.length, logs })
})

// ─── Instance info ────────────────────────────────────────────────────────────

app.get('/instance/chats/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const session = activeClients.get(userId)
  if (!session) return res.status(404).send('Sessão não encontrada.')
  session.apiCalls++
  await syncSessionReadiness(session)
  if (!session.ready) return res.status(400).send('Instância não pronta.')
  try {
    const chats = await session.client.getChats()
    const list = chats.map((chat: { id: { _serialized: string; user?: string }; name?: string; formattedTitle?: string }) => ({
      id: chat.id._serialized, name: chat.name || chat.formattedTitle || chat.id.user,
    }))
    res.json({ userId, instanceId: session.instanceId, total: list.length, chats: list })
  } catch (err: any) {
    console.error(err)
    res.status(500).send('Erro ao buscar chats.')
  }
})

app.get('/instance/status/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const session = activeClients.get(userId)
  if (!session) {
    return res.status(404).json({
      status: 'not_found', state: null, authenticated: false, readySince: null, lastError: null,
    })
  }
  session.apiCalls++
  await syncSessionReadiness(session)
  res.json({
    userId,
    instanceId: session.instanceId,
    status: computeSessionStatus(session),
    state: session.lastKnownState,
    authenticated: session.authenticated,
    readySince: session.readyAt?.toISOString() ?? null,
    lastError: session.lastError,
  })
})

app.get('/instance/qr/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const session = activeClients.get(userId)
  if (!session) return res.status(404).json({ qr: null, status: 'not_found' })
  session.apiCalls++

  if (session.ready) return res.json({ qr: null, status: 'ready', userId, instanceId: session.instanceId })
  if (session.qrCode) return res.json({ qr: session.qrCode, status: 'qr_pending', userId, instanceId: session.instanceId })
  return res.json({ qr: null, status: 'initializing', userId, instanceId: session.instanceId })
})

app.get('/instance/active', (_req: Request, res: Response) => {
  const users = []
  for (const [userId, session] of activeClients.entries()) {
    users.push({
      userId, instanceId: session.instanceId, number: session.number || null,
      ready: session.ready, authenticated: session.authenticated,
      state: session.lastKnownState, queueLength: messageQueues.get(userId)?.length || 0,
    })
  }
  res.json({ total: users.length, instances: users })
})

app.get('/instance/info/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const session = activeClients.get(userId)
  if (!session) return res.status(404).send('Sessão não encontrada.')
  session.apiCalls++
  await syncSessionReadiness(session)
  res.json({
    userId: session.userId, instanceId: session.instanceId,
    ready: session.ready, authenticated: session.authenticated,
    state: session.lastKnownState, lastError: session.lastError,
    createdAt: session.createdAt, readySince: session.readyAt?.toISOString() ?? null,
    number: session.number || null, queueLength: messageQueues.get(userId)?.length || 0,
  })
})

app.post('/instance/disconnect/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const session = activeClients.get(userId)
  if (!session) return res.status(404).send('Sessão não encontrada.')
  session.apiCalls++

  console.log(`[${ts()}] [${userId}] [DISCONNECT] Desconectando sessão (instanceId: ${session.instanceId})...`)
  session.destroyingIntentionally = true // impede reconexão automática

  try { await session.client.logout(); await session.client.destroy() } catch {}

  activeClients.delete(userId)
  pausedNumbers.delete(userId)
  messageQueues.delete(userId)
  isSendingMessage.delete(userId)

  console.log(`[${ts()}] [${userId}] [DISCONNECT] Sessão removida — enviadas: ${session.sentMessages} | recebidas: ${session.receivedMessages} | chamadas API: ${session.apiCalls}`)
  res.json({ message: `Sessão ${userId} desconectada.`, userId, instanceId: session.instanceId })
})

app.delete('/instance/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)

  const session = activeClients.get(userId)
  if (session) {
    session.destroyingIntentionally = true
    try { await session.client.destroy() } catch {}
    activeClients.delete(userId)
    pausedNumbers.delete(userId)
    messageQueues.delete(userId)
    isSendingMessage.delete(userId)
  }

  // Remove credenciais do banco (RemoteAuth não chama delete sem logout explícito)
  try {
    await pool.query('DELETE FROM whatsapp_sessions WHERE session_id = $1', [`RemoteAuth-${userId}`])
  } catch (e: any) {
    console.error(`[${ts()}] [${userId}] [DELETE] Erro ao remover do banco:`, e?.message)
  }

  // Limpa diretório temporário do RemoteAuth em /tmp se ainda existir
  const tempDir = `/tmp/wwebjs/wwebjs_temp_session_${userId}`
  if (existsSync(tempDir)) {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch {}
  }

  console.log(`[${ts()}] [${userId}] [DELETE] Sessão deletada do banco e da memória`)
  res.json({ message: `Sessão ${userId} deletada.`, userId })
})

app.all('/webhook/*splat', (_req: Request, res: Response) => {
  res.status(410).json({ ok: false, error: 'webhook_disabled', message: 'Endpoints de webhook/n8n foram desativados neste projeto.' })
})

// ─── Fila de envio ────────────────────────────────────────────────────────────

async function processQueue(userId: string) {
  if (isSendingMessage.get(userId)) return
  const session = activeClients.get(userId)
  if (!session || !session.ready) return
  const queue = messageQueues.get(userId)
  if (!queue || queue.length === 0) return

  isSendingMessage.set(userId, true)
  console.log(`[${ts()}] [${userId}] [QUEUE] Processando ${queue.length} item(ns) pendente(s)`)

  try {
    while (queue.length > 0) {
      const currentItem = queue.shift()
      if (!currentItem) continue
      const { number, message, messageId, resolve, reject } = currentItem
      const type = currentItem.media?.ptt ? 'ptt' : currentItem.media ? 'image' : 'text'
      const t0 = Date.now()
      console.log(`[${ts()}] [${userId}] [SEND] Enviando ${type} para ${number} | fila restante: ${queue.length}`)

      try {
        const numberId = await session.client.getNumberId(number)
        if (!numberId) {
          console.warn(`[${ts()}] [${userId}] [SEND_FAIL] Número sem WhatsApp: ${number}`)
          reject(new Error(`Número ${number} não possui WhatsApp.`))
          continue
        }

        const chatId = numberId._serialized
        const sendPayload: string | MessageMedia = currentItem.media
          ? new MessageMedia(currentItem.media.mimetype, currentItem.media.base64, currentItem.media.filename)
          : message
        const sendOptions: Record<string, unknown> = { sendSeen: false }
        if (currentItem.media?.ptt) sendOptions.sendAudioAsVoice = true

        const sentMessage = await session.client.sendMessage(chatId, sendPayload, sendOptions)
        session.sentMessages += 1

        const ms = Date.now() - t0
        const logType = currentItem.media?.ptt ? 'ptt' : currentItem.media ? 'image' : 'chat'
        const logBody = currentItem.media?.ptt ? `[voz: ${currentItem.media.filename}]`
          : currentItem.media ? `[imagem: ${currentItem.media.filename}]` : message
        console.log(`[${ts()}] [${userId}] [SEND_OK] ${type} entregue para ${number} em ${ms}ms (waId=${sentMessage.id._serialized.slice(-12)}) | total: ${session.sentMessages}`)

        cappedMapSet(messageRegistry, messageId, {
          userId, instanceId: session.instanceId, timestamp: new Date(),
          type: 'sent', whatsappMessageId: sentMessage.id._serialized, to: number,
        }, MAX_REGISTRY_SIZE)

        session.logs.push({
          messageId, userId, instanceId: session.instanceId, number, name: number,
          body: logBody, type: logType, direction: 'sent', timestamp: new Date(),
          media: currentItem.media ? { mimetype: currentItem.media.mimetype, filename: currentItem.media.filename } : null,
          whatsappMessageId: sentMessage.id._serialized,
        })
        if (session.logs.length > MAX_SESSION_LOGS) session.logs.shift()

        resolve({
          success: true, messageId,
          message: currentItem.media?.ptt ? 'Áudio enviado!' : currentItem.media ? 'Imagem enviada!' : 'Mensagem enviada!',
          whatsappMessageId: sentMessage.id._serialized,
        })
      } catch (err: any) {
        const ms = Date.now() - t0
        console.error(`[${ts()}] [${userId}] [SEND_FAIL] ${type} para ${number} em ${ms}ms: ${err.message}`)
        reject(new Error(`Falha ao enviar mensagem para ${number}: ${err.message}`))
      }
    }
  } finally {
    isSendingMessage.set(userId, false)
    console.log(`[${ts()}] [${userId}] [QUEUE] Fila finalizada`)
  }
}

// ─── Helpers compartilhados dos endpoints de envio ────────────────────────────

function checkSendPreconditions(session: SessionData, _userId: string, res: Response): boolean {
  if (!session.ready) {
    res.status(400).send('Instância não pronta.')
    return false
  }
  if (isInWarmup(session)) {
    res.status(503).json({ error: 'instance_not_ready', retryAfter: 5 })
    return false
  }
  return true
}

function handleSendError(err: any, userId: string, label: string, session: SessionData, res: Response): void {
  if (isWidFactoryError(err)) {
    console.warn(`[${ts()}] [${userId}] [SEND_FAIL] WidFactory — retornando 503`)
    res.status(503).json({ error: 'instance_not_ready', retryAfter: 10 })
    return
  }
  console.error(`[${ts()}] [${userId}] [SEND_FAIL] ${label}:`, err.message)
  res.status(500).json({
    error: `Erro ao enviar ${label}.`,
    details: err instanceof Error ? err.message : String(err),
    userId, instanceId: session.instanceId,
  })
}

// ─── Endpoints de envio ───────────────────────────────────────────────────────

app.post('/message/send-text/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const body = (req.body ?? {}) as { number?: unknown; message?: unknown }
  const number  = String(body.number  ?? '').trim()
  const message = String(body.message ?? '').trim()

  if (!number || !message) {
    return res.status(400).json({
      ok: false, error: 'invalid_payload',
      details: "Campos 'number' e 'message' são obrigatórios no JSON body.",
      example: { number: '5511999999999', message: 'Olá!' },
    })
  }

  const session = activeClients.get(userId)
  if (!session) return res.status(404).send('Sessão não encontrada.')
  session.apiCalls++

  await syncSessionReadiness(session)
  if (!checkSendPreconditions(session, userId, res)) return

  console.log(`[${ts()}] [${userId}] [SEND] /send-text → ${number} | fila: ${messageQueues.get(userId)?.length ?? 0}`)
  if (!messageQueues.has(userId)) messageQueues.set(userId, [])
  const messageId = generateUniqueId()

  const sendPromise = new Promise<SendResult>((resolve, reject) => {
    messageQueues.get(userId)?.push({ number, message, messageId, resolve, reject })
  })
  processQueue(userId)

  try {
    const result = await Promise.race([
      sendPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Tempo limite excedido. Tente novamente.')), SEND_TIMEOUT_MS)),
    ])
    res.json({ ...result, userId, instanceId: session.instanceId })
  } catch (err: any) {
    handleSendError(err, userId, 'mensagem', session, res)
  }
})

app.post('/message/send-image/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const session = activeClients.get(userId)
  if (!session) return res.status(404).send('Sessão não encontrada.')

  try {
    await new Promise<void>((resolve, reject) => {
      upload.single('image')(req, res, (err: unknown) => (err ? reject(err) : resolve()))
    })
  } catch (err: any) {
    return res.status(400).json({
      ok: false, error: 'invalid_file',
      details: err?.code === 'LIMIT_FILE_SIZE'
        ? `Arquivo muito grande. Máximo ${WHATSAPP_MEDIA_LIMIT_MB}MB.`
        : err.message ?? 'Arquivo inválido.',
    })
  }

  const number  = String(req.body.number  ?? '').trim()
  const caption = String(req.body.caption ?? '').trim()
  if (!number) return res.status(400).json({ ok: false, error: 'invalid_payload', details: "Campo 'number' é obrigatório." })
  if (!req.file) return res.status(400).json({ ok: false, error: 'invalid_payload', details: "Campo 'image' (arquivo) é obrigatório." })

  session.apiCalls++
  await syncSessionReadiness(session)
  if (!checkSendPreconditions(session, userId, res)) return

  console.log(`[${ts()}] [${userId}] [SEND] /send-image → ${number} | ${req.file.originalname ?? 'sem nome'} (${(req.file.size / 1024).toFixed(1)} KB) | fila: ${messageQueues.get(userId)?.length ?? 0}`)
  if (!messageQueues.has(userId)) messageQueues.set(userId, [])

  const messageId = generateUniqueId()
  const base64 = req.file.buffer.toString('base64')
  const ext = req.file.mimetype.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg'
  const safeName = (req.file.originalname ?? '').trim().replace(/[/\\]/g, '').replace(/\.\./g, '').trim()
  const filename = safeName || `image-${Date.now()}.${ext}`

  const sendPromise = new Promise<SendResult>((resolve, reject) => {
    messageQueues.get(userId)!.push({ number, message: caption, messageId, media: { base64, mimetype: req.file!.mimetype, filename }, resolve, reject })
  })
  processQueue(userId)

  try {
    const result = await Promise.race([
      sendPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Tempo limite excedido. Tente novamente.')), SEND_TIMEOUT_MS)),
    ])
    res.json({ ...result, userId, instanceId: session.instanceId })
  } catch (err: any) {
    handleSendError(err, userId, 'imagem', session, res)
  }
})

app.post('/message/send-audio/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const session = activeClients.get(userId)
  if (!session) return res.status(404).send('Sessão não encontrada.')

  try {
    await new Promise<void>((resolve, reject) => {
      uploadAudio.single('audio')(req, res, (err: unknown) => (err ? reject(err) : resolve()))
    })
  } catch (err: any) {
    return res.status(400).json({
      ok: false, error: 'invalid_file',
      details: err?.code === 'LIMIT_FILE_SIZE'
        ? `Arquivo muito grande. Máximo ${WHATSAPP_MEDIA_LIMIT_MB}MB.`
        : err.message ?? 'Arquivo inválido.',
    })
  }

  const number = String(req.body.number ?? '').trim()
  if (!number) return res.status(400).json({ ok: false, error: 'invalid_payload', details: "Campo 'number' é obrigatório." })
  if (!req.file) return res.status(400).json({ ok: false, error: 'invalid_payload', details: "Campo 'audio' (arquivo) é obrigatório." })

  session.apiCalls++
  await syncSessionReadiness(session)
  if (!checkSendPreconditions(session, userId, res)) return

  console.log(`[${ts()}] [${userId}] [SEND] /send-audio → ${number} | ${req.file.originalname ?? 'sem nome'} (${(req.file.size / 1024).toFixed(1)} KB) | fila: ${messageQueues.get(userId)?.length ?? 0}`)
  if (!messageQueues.has(userId)) messageQueues.set(userId, [])

  const messageId = generateUniqueId()
  const base64 = req.file.buffer.toString('base64')
  const ext = (req.file.mimetype.split('/')[1]?.split(';')[0] ?? 'ogg').replace('mpeg', 'mp3')
  const safeName = (req.file.originalname ?? '').trim().replace(/[/\\]/g, '').replace(/\.\./g, '').trim()
  const filename = safeName || `audio-${Date.now()}.${ext}`

  const sendPromise = new Promise<SendResult>((resolve, reject) => {
    messageQueues.get(userId)!.push({ number, message: '', messageId, media: { base64, mimetype: req.file!.mimetype, filename, ptt: true }, resolve, reject })
  })
  processQueue(userId)

  try {
    const result = await Promise.race([
      sendPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Tempo limite excedido. Tente novamente.')), SEND_TIMEOUT_MS)),
    ])
    res.json({ ...result, userId, instanceId: session.instanceId })
  } catch (err: any) {
    handleSendError(err, userId, 'áudio', session, res)
  }
})

// ─── IA pause/resume ──────────────────────────────────────────────────────────

app.post('/ia/pause/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const { number } = req.body
  if (!number) return res.status(400).send('Número é obrigatório.')
  const session = activeClients.get(userId)
  if (!session) return res.status(404).send('Sessão não encontrada.')
  session.apiCalls++
  if (!pausedNumbers.has(userId)) pausedNumbers.set(userId, new Set())
  pausedNumbers.get(userId)!.add(number)
  console.log(`[${ts()}] [${userId}] [IA] Pausada para ${number}`)
  res.json({ message: `Atendimento da IA pausado para ${number} em ${userId}`, userId, instanceId: session.instanceId, number, actionId: generateUniqueId() })
})

app.post('/ia/resume/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const { number } = req.body
  if (!number) return res.status(400).send('Número é obrigatório.')
  const session = activeClients.get(userId)
  if (!session) return res.status(404).send('Sessão não encontrada.')
  session.apiCalls++
  pausedNumbers.get(userId)?.delete(number)
  console.log(`[${ts()}] [${userId}] [IA] Retomada para ${number}`)
  res.json({ message: `Atendimento da IA retomado para ${number} em ${userId}`, userId, instanceId: session.instanceId, number, actionId: generateUniqueId() })
})

// ─── Mídia / mensagem por ID ──────────────────────────────────────────────────

app.get('/message/media/:userId/:whatsappMessageId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const whatsappMessageId = getParam(req.params.whatsappMessageId)
  const session = activeClients.get(userId)
  if (!session) return res.status(404).send('Sessão não encontrada.')
  session.apiCalls++
  await syncSessionReadiness(session)
  if (!session.ready) return res.status(400).send('Instância não pronta.')
  try {
    const message = await session.client.getMessageById(whatsappMessageId)
    if (!message.hasMedia) return res.status(400).send('Esta mensagem não contém mídia.')
    const media = await message.downloadMedia()
    if (!media) return res.status(404).send('Falha ao baixar mídia da mensagem.')
    const mediaId = generateUniqueId()
    const messageData = message as unknown as { _data?: { filename?: string } }
    res.json({ mediaId, whatsappMessageId, userId, instanceId: session.instanceId, mimetype: media.mimetype, data: media.data, filename: messageData._data?.filename || null })
  } catch (err: any) {
    console.error(`[${ts()}] [${userId}] Erro ao obter mídia:`, err)
    res.status(500).send(`Erro ao obter mídia: ${err?.message}`)
  }
})

app.get('/message/:messageId', (req: Request, res: Response) => {
  const messageId = getParam(req.params.messageId)
  const messageInfo = messageRegistry.get(messageId)
  if (!messageInfo) return res.status(404).json({ error: 'Mensagem não encontrada.' })
  res.json({ messageId, data: messageInfo })
})

app.get('/messages/sent/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const session = activeClients.get(userId)
  if (!session) return res.status(404).send('Sessão não encontrada.')
  session.apiCalls++
  res.json({ userId, instanceId: session.instanceId, sentMessages: session.sentMessages })
})

app.get('/messages/registry', (req: Request, res: Response) => {
  const limitParsed  = parseInt(getParam(req.query.limit  as string | undefined), 10)
  const offsetParsed = parseInt(getParam(req.query.offset as string | undefined), 10)
  const limit  = Math.min(isNaN(limitParsed)  ? 100 : Math.max(1, limitParsed),  500)
  const offset = isNaN(offsetParsed) ? 0 : Math.max(0, offsetParsed)
  const all  = Array.from(messageRegistry.entries()).map(([messageId, data]) => ({ messageId, data }))
  const page = all.slice(offset, offset + limit)
  res.json({ total: all.length, limit, offset, messages: page })
})

// ─── Insights ─────────────────────────────────────────────────────────────────

app.get('/instance/insights', (_req: Request, res: Response) => {
  const insights = []
  for (const [userId, session] of activeClients.entries()) {
    insights.push({
      userId, instanceId: session.instanceId, createdAt: session.createdAt,
      ready: session.ready, number: session.number || null,
      totalApiCalls: session.apiCalls, sentMessages: session.sentMessages,
      receivedMessages: session.receivedMessages, authenticated: session.authenticated,
      state: session.lastKnownState, queueLength: messageQueues.get(userId)?.length || 0,
      cachedLogs: session.logs.length,
    })
  }
  res.json({ total: insights.length, insights })
})

app.get('/instance/insights/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const session = activeClients.get(userId)
  if (!session) return res.status(404).send('Sessão não encontrada.')
  session.apiCalls++
  res.json({
    userId: session.userId, instanceId: session.instanceId, createdAt: session.createdAt,
    ready: session.ready, number: session.number || null,
    totalApiCalls: session.apiCalls, sentMessages: session.sentMessages,
    receivedMessages: session.receivedMessages, authenticated: session.authenticated,
    state: session.lastKnownState, queueLength: messageQueues.get(userId)?.length || 0,
    cachedLogs: session.logs.length,
  })
})

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'API WhatsApp ativa 🚀', version: '2.0.0', features: ['Unique IDs', 'Message Registry', 'Instance Tracking', 'Webhook Disabled'] })
})

// ─── Processo ─────────────────────────────────────────────────────────────────

process.on('uncaughtException', (err: Error) => {
  console.error(`[${ts()}] [PROCESSO] Exceção não capturada — servidor mantido vivo:`, err.message)
})

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error(`[${ts()}] [PROCESSO] Rejeição não tratada — servidor mantido vivo:`, msg)
})

async function gracefulShutdown(signal: string) {
  console.log(`[${ts()}] [SHUTDOWN] Sinal ${signal} recebido. Encerrando ${activeClients.size} sessão(ões)...`)
  for (const [userId, session] of activeClients.entries()) {
    session.destroyingIntentionally = true
    try { await session.client.destroy(); console.log(`[${ts()}] [SHUTDOWN] Sessão ${userId} encerrada`) } catch {}
  }
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT',  () => gracefulShutdown('SIGINT'))

const PORT = process.env.PORT || 8080

async function start() {
  await initDatabase()

  app.listen(PORT, async () => {
    console.log(`[${ts()}] [STARTUP] Backend WhatsApp rodando na porta ${PORT}`)
    console.log(`[${ts()}] [STARTUP] Hostname:        ${hostname()}`)
    console.log(`[${ts()}] [STARTUP] API_KEY:         ${API_KEY ? 'configurada ✓' : 'NÃO CONFIGURADA ⚠'}`)
    console.log(`[${ts()}] [STARTUP] WEBHOOK_URL:     ${process.env.WEBHOOK_URL || 'não configurada'}`)
    console.log(`[${ts()}] [STARTUP] WEBHOOK_SECRET:  ${process.env.WEBHOOK_SECRET ? 'configurado ✓' : 'não configurado'}`)
    console.log(`[${ts()}] [STARTUP] SENDERWHATS_URL: ${process.env.SENDERWHATS_URL || 'não configurada'}`)
    console.log(`[${ts()}] [STARTUP] DATABASE_URL:    ${process.env.DATABASE_URL ? 'configurada ✓' : 'NÃO CONFIGURADA ⚠'}`)

    const chromiumPath = '/usr/bin/chromium'
    if (existsSync(chromiumPath)) {
      const ver = spawnSync(chromiumPath, ['--version'], { encoding: 'utf8' })
      console.log(`[${ts()}] [STARTUP] Chromium:        ${ver.stdout?.trim() || 'encontrado (versão indisponível)'}`)
    } else {
      console.error(`[${ts()}] [STARTUP] Chromium:        NÃO ENCONTRADO em ${chromiumPath} — instâncias falharão ao iniciar`)
    }

    const toRecover = await loadPersistedSessions()
    if (toRecover.length === 0) {
      console.log(`[${ts()}] [STARTUP] Nenhuma sessão no banco para recuperar`)
    } else {
      console.log(`[${ts()}] [STARTUP] Recuperando ${toRecover.length} sessão(ões): ${toRecover.join(', ')}`)
      toRecover.forEach((uid: string, index: number) => {
        setTimeout(() => {
          console.log(`[${ts()}] [STARTUP] Iniciando recuperação de: ${uid}`)
          createSession(uid)
        }, index * 5_000)
      })
    }
  })
}

start().catch(err => {
  console.error(`[${ts()}] [STARTUP] Falha fatal ao iniciar:`, err)
  process.exit(1)
})
