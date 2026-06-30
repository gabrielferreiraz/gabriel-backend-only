import express, { type Request, type Response, type NextFunction } from "express"
import cors from "cors"
import qrcode from "qrcode"
import multer from "multer"
import * as nodeCrypto from "node:crypto"
import { hostname } from "os"
import { Pool } from "pg"
import makeWASocket, {
  DisconnectReason,
  Browsers,
  initAuthCreds,
  BufferJSON,
  type AuthenticationCreds,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"
// Logger silencioso compatível com a interface que Baileys espera
const noopLogger = {
  level: 'silent',
  trace: () => {}, debug: () => {}, info: () => {},
  warn:  () => {}, error: () => {}, fatal: () => {},
  child: (): any => noopLogger,
} as any

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function initDatabase(): Promise<void> {
  await pool.query('SELECT 1 FROM baileys_sessions LIMIT 1')
  console.log(`[${ts()}] [DB] Conexão verificada — baileys_sessions acessível`)
}

async function usePostgreSQLAuthState(userId: string): Promise<{
  state: { creds: AuthenticationCreds; keys: any }
  saveCreds: () => Promise<void>
}> {
  const sessionKey = `baileys-${userId}`
  const { rows } = await pool.query(
    'SELECT creds, keys FROM baileys_sessions WHERE session_id = $1',
    [sessionKey]
  )
  const row = rows[0]

  let creds: AuthenticationCreds = row?.creds
    ? (JSON.parse(row.creds, BufferJSON.reviver) as AuthenticationCreds)
    : initAuthCreds()

  let keysData: Record<string, Record<string, any>> = row?.keys
    ? JSON.parse(row.keys, BufferJSON.reviver)
    : {}

  const saveCreds = async () => {
    await pool.query(
      `INSERT INTO baileys_sessions (session_id, creds, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (session_id) DO UPDATE SET creds = EXCLUDED.creds, updated_at = NOW()`,
      [sessionKey, JSON.stringify(creds, BufferJSON.replacer)]
    )
  }

  const saveKeys = async () => {
    await pool.query(
      `INSERT INTO baileys_sessions (session_id, keys, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (session_id) DO UPDATE SET keys = EXCLUDED.keys, updated_at = NOW()`,
      [sessionKey, JSON.stringify(keysData, BufferJSON.replacer)]
    )
  }

  const keys = {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const result: { [id: string]: SignalDataTypeMap[T] } = {}
      const store = keysData[type as string] ?? {}
      for (const id of ids) {
        if (store[id] !== undefined) result[id] = store[id]
      }
      return result
    },
    set: async (data: any) => {
      for (const [type, typeData] of Object.entries(data)) {
        keysData[type] ??= {}
        for (const [id, val] of Object.entries(typeData as Record<string, any>)) {
          if (val != null) keysData[type][id] = val
          else delete keysData[type][id]
        }
      }
      await saveKeys()
    },
    transaction: async (exec: () => Promise<void>) => exec(),
  }

  return { state: { creds, keys }, saveCreds }
}

async function loadPersistedSessions(): Promise<string[]> {
  try {
    const { rows } = await pool.query(
      'SELECT session_id FROM baileys_sessions WHERE creds IS NOT NULL'
    )
    return rows.map((r: { session_id: string }) => r.session_id.replace(/^baileys-/, ''))
  } catch (e: any) {
    console.error(`[${ts()}] [DB] Erro ao carregar sessões:`, e?.message)
    return []
  }
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express()
app.use(cors())
app.use(express.json())

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
  console.warn('[SEGURANÇA] API_KEY não configurada — servidor acessível sem autenticação.')
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY) return next()
  const auth = req.headers.authorization
  if (!auth || auth !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' })
  }
  next()
}

app.use('/instance', authMiddleware)
app.use('/message', authMiddleware)
app.use('/messages', authMiddleware)
app.use('/ia', authMiddleware)

// ─── Tipos ────────────────────────────────────────────────────────────────────

type MediaLog = { mimetype: string; filename: string; data?: string }

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
  sock: ReturnType<typeof makeWASocket>
  qrCode: string | null
  ready: boolean
  authenticated: boolean
  lastError: string | null
  userId: string
  instanceId: string
  logs: MessageLog[]
  createdAt: Date
  readyAt: Date | null
  destroyingIntentionally: boolean
  sentMessages: number
  receivedMessages: number
  apiCalls: number
  number?: string
  retryCount: number
}

// ─── Utilitários ──────────────────────────────────────────────────────────────

function generateUniqueId() { return nodeCrypto.randomUUID() }
function ts(): string { return new Date().toISOString().replace('T', ' ').slice(0, 23) }

const ACK_LABELS: Record<number, string> = {
  0: 'pendente', 1: 'enviada', 2: 'entregue', 3: 'lida', 4: 'reproduzida',
}

// Baileys status → whatsapp-web.js ack values
const BAILEYS_STATUS_TO_ACK: Record<number, number> = {
  2: 1,  // SERVER_ACK
  3: 2,  // DELIVERY_ACK → entregue
  4: 3,  // READ → lida
  5: 4,  // PLAYED → reproduzida
}

const activeClients    = new Map<string, SessionData>()
const pausedNumbers    = new Map<string, Set<string>>()
const messageQueues    = new Map<string, QueueItem[]>()
const isSendingMessage = new Map<string, boolean>()
const messageRegistry  = new Map<string, RegistryPayload>()
const sessionRetryCount = new Map<string, number>()  // persiste contagem entre reconexões do mesmo userId

const MAX_REGISTRY_SIZE       = 5000
const MAX_SESSION_LOGS        = 200
const WHATSAPP_MEDIA_LIMIT_MB = 16
const SEND_TIMEOUT_MS         = 60_000

const ALLOWED_IMAGE_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const ALLOWED_AUDIO_MIMETYPES = new Set([
  'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/mp4',
  'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/aac', 'audio/webm',
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
    else cb(new Error(`Tipo não suportado: ${file.mimetype}.`))
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
  if (session.destroyingIntentionally || session.lastError) return 'disconnected'
  return 'initializing'
}

function deriveState(session: SessionData): string {
  if (session.ready) return 'CONNECTED'
  if (session.qrCode) return 'QR_PENDING'
  if (session.destroyingIntentionally || session.lastError) return 'DISCONNECTED'
  return 'INITIALIZING'
}

// ─── Criação de sessão (Baileys) ──────────────────────────────────────────────

function createSession(userId: string): string {
  const existing = activeClients.get(userId)
  if (existing) {
    // Sessão morta (lastError + sem socket ativo): limpa e recria
    if (existing.lastError && !existing.ready && !existing.authenticated) {
      existing.destroyingIntentionally = true
      try { existing.sock.end(undefined) } catch {}
      activeClients.delete(userId)
    } else {
      return existing.instanceId
    }
  }

  const instanceId = generateUniqueId()
  console.log(`[${ts()}] [${userId}] Criando sessão Baileys (instanceId: ${instanceId})...`)

  ;(async () => {
    const { state, saveCreds } = await usePostgreSQLAuthState(userId)

    // Guarda contra race condition: outra chamada pode ter criado a sessão durante o await acima
    if (activeClients.has(userId)) {
      console.log(`[${ts()}] [${userId}] Sessão já existe após consulta ao banco — abortando duplicata`)
      return
    }

    const sock = makeWASocket({
      auth: state,
      logger: noopLogger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 30_000,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    })

    let qrActive = true  // false quando socket fecha — impede callback async de sobrescrever qrCode

    const sessionData: SessionData = {
      sock,
      qrCode: null,
      ready: false,
      authenticated: false,
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
      retryCount: 0,
    }
    activeClients.set(userId, sessionData)

    // Salva credenciais sempre que atualizadas
    sock.ev.on('creds.update', saveCreds)

    // ── Eventos de conexão ──
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        qrcode.toDataURL(qr, (err: Error | null | undefined, url: string) => {
          if (!err && qrActive) {
            sessionData.qrCode = url
            console.log(`[${ts()}] [${userId}] [QR] Novo QR code gerado — aguardando scan`)
          }
        })
      }

      if (connection === 'open') {
        const rawId = sock.user?.id ?? ''
        const number = rawId.split(':')[0].split('@')[0]
        const uptime = Math.round((Date.now() - sessionData.createdAt.getTime()) / 1000)
        sessionData.ready = true
        sessionData.authenticated = true
        sessionData.qrCode = null
        sessionData.lastError = null
        sessionData.readyAt = new Date()
        sessionData.retryCount = 0
        sessionData.number = number
        sessionRetryCount.delete(userId)
        console.log(`[${ts()}] [${userId}] [READY] Conexão aberta — número: ${number} | uptime: ${uptime}s`)
        processQueue(userId)
      }

      if (connection === 'close') {
        qrActive = false
        sessionData.ready = false
        sessionData.authenticated = false
        sessionData.qrCode = null

        // Drena fila pendente
        const queue = messageQueues.get(userId)
        if (queue && queue.length > 0) {
          const pending = queue.splice(0)
          for (const item of pending) item.reject(new Error('Sessão desconectada. Tente novamente.'))
          console.warn(`[${ts()}] [${userId}] [DISCONNECT] Fila drenada: ${pending.length} item(ns)`)
        }

        if (sessionData.destroyingIntentionally) {
          console.log(`[${ts()}] [${userId}] [DISCONNECT] Encerrado intencionalmente`)
          return
        }

        const err = lastDisconnect?.error as Boom | undefined
        const statusCode = err?.output?.statusCode

        // ── Casos que exigem novo QR (não reconectar automaticamente) ──
        const needsNewQR = (
          statusCode === DisconnectReason.loggedOut ||   // 401 — logout manual ou banimento
          statusCode === DisconnectReason.badSession ||  // 500 — credenciais corrompidas
          statusCode === 403 ||                          // 403 — forbidden (ban potencial)
          statusCode === 405                             // 405 — WhatsApp rejeitou o registro do dispositivo
        )

        if (needsNewQR) {
          const reason =
            statusCode === 403 ? 'Conta possivelmente banida (403)' :
            statusCode === 405 ? 'Conexão rejeitada pelo WhatsApp — aguarde e tente reconectar' :
            statusCode === DisconnectReason.badSession ? 'Sessão corrompida — novo QR necessário' :
            'Desconectado (logout) — novo QR necessário'

          console.warn(`[${ts()}] [${userId}] [DISCONNECT] ${reason} — credenciais removidas`)
          sessionData.lastError = reason
          sessionRetryCount.delete(userId)

          await pool.query(
            'DELETE FROM baileys_sessions WHERE session_id = $1',
            [`baileys-${userId}`]
          ).catch(() => {})

          // Mantém na memória com status 'disconnected' para a interface mostrar o erro
          return
        }

        // ── Casos que reconectam automaticamente com backoff exponencial ──
        const retryCount = (sessionRetryCount.get(userId) ?? 0) + 1
        sessionRetryCount.set(userId, retryCount)

        // Delay: 5s → 10s → 20s → 40s → 80s → máx 300s (5 min)
        const backoffMs = Math.min(5_000 * Math.pow(2, retryCount - 1), 300_000)

        // connectionReplaced (440): outra aba/app abriu o WA — espera mais para não conflitar
        const label = statusCode === DisconnectReason.connectionReplaced
          ? 'substituída por outro cliente'
          : statusCode === DisconnectReason.restartRequired
            ? 'reinício solicitado pelo WA'
            : `código ${statusCode ?? '?'}`

        console.log(`[${ts()}] [${userId}] [RECONNECT] ${label} — tentativa ${retryCount}, aguardando ${backoffMs / 1000}s`)

        setTimeout(() => {
          if (activeClients.has(userId) && !sessionData.destroyingIntentionally) {
            activeClients.delete(userId)
            createSession(userId)
          }
        }, backoffMs)
      }
    })

    // ── ACK de entrega / leitura ──
    sock.ev.on('messages.update', async (msgs) => {
      const senderwhatsUrl = process.env.SENDERWHATS_URL
      if (!senderwhatsUrl) return
      const webhookSecret = process.env.WEBHOOK_SECRET

      for (const { key, update } of msgs) {
        if (!key.fromMe) continue
        const ack = BAILEYS_STATUS_TO_ACK[update.status ?? 0] ?? 0
        if (ack < 2) continue

        const messageId = key.id ?? ''
        const ackName = ACK_LABELS[ack] ?? `ack-${ack}`
        console.log(`[${ts()}] [${userId}] [ACK] ...${messageId.slice(-10)} → ${ackName}`)

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
          if (!res.ok) console.warn(`[${ts()}] [${userId}] [ACK] webhook → ${res.status} (${Date.now() - t0}ms)`)
          else console.log(`[${ts()}] [${userId}] [ACK] webhook → OK (${Date.now() - t0}ms)`)
        } catch (e: any) {
          if (e?.name !== 'TimeoutError' && e?.name !== 'AbortError') {
            console.error(`[${ts()}] [${userId}] [ACK] webhook erro:`, e?.message)
          }
        }
      }
    })

    // ── Mensagens recebidas ──
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return

      for (const msg of messages) {
        try {
          if (msg.key.fromMe) continue

          const jid = msg.key.remoteJid ?? ''
          if (jid.endsWith('@g.us') || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) continue

          if (!msg.message) continue

          // Desempacota viewOnce antes de checar o tipo real
          let msgContent: Record<string, any> = msg.message as any
          if (msgContent.viewOnceMessage?.message) msgContent = msgContent.viewOnceMessage.message
          if (msgContent.viewOnceMessageV2?.message?.message) msgContent = msgContent.viewOnceMessageV2.message.message

          const msgType = Object.keys(msgContent)[0]
          if (!msgType) continue

          const IGNORED_TYPES = ['protocolMessage', 'senderKeyDistributionMessage', 'reactionMessage', 'pollUpdateMessage', 'ephemeralMessage', 'keepInChatMessage']
          if (IGNORED_TYPES.includes(msgType)) continue

          sessionData.receivedMessages++
          const from = jid.replace('@s.whatsapp.net', '')
          const pushName = msg.pushName || from

          // Extrai corpo e tipo de mídia
          let rawBody = ''
          let hasMedia = false
          let msgTypeName = 'chat'

          if (msgContent.conversation) {
            rawBody = msgContent.conversation
            msgTypeName = 'chat'
          } else if (msgContent.extendedTextMessage?.text) {
            rawBody = msgContent.extendedTextMessage.text
            msgTypeName = 'chat'
          } else if (msgContent.imageMessage) {
            rawBody = msgContent.imageMessage.caption ?? ''
            hasMedia = true; msgTypeName = 'image'
          } else if (msgContent.audioMessage) {
            hasMedia = true
            msgTypeName = msgContent.audioMessage.ptt ? 'ptt' : 'audio'
          } else if (msgContent.videoMessage) {
            rawBody = msgContent.videoMessage.caption ?? ''
            hasMedia = true; msgTypeName = 'video'
          } else if (msgContent.documentMessage) {
            rawBody = msgContent.documentMessage.title ?? ''
            hasMedia = true; msgTypeName = 'document'
          } else if (msgContent.stickerMessage) {
            hasMedia = true; msgTypeName = 'sticker'
          }

          const preview = rawBody.slice(0, 80).replace(/\n/g, ' ')
          const previewFmt = msgTypeName === 'ptt' ? '[ptt/áudio]'
            : rawBody.length > 0 ? `"${preview}${rawBody.length > 80 ? '...' : ''}"` : `[${msgTypeName}]`
          console.log(`[${ts()}] [${userId}] [MSG] ← de ${from} (${pushName}) ${previewFmt} | total: ${sessionData.receivedMessages}`)

          const messageId = generateUniqueId()
          const whatsappMsgId = msg.key.id ?? ''

          cappedMapSet(messageRegistry, messageId, {
            userId, instanceId, timestamp: new Date(), type: 'received', whatsappMessageId: whatsappMsgId,
          }, MAX_REGISTRY_SIZE)

          const log: MessageLog = {
            messageId, userId, instanceId, number: from, name: pushName,
            body: rawBody, type: msgTypeName, direction: 'received',
            timestamp: new Date(), media: null, whatsappMessageId: whatsappMsgId,
          }
          sessionData.logs.push(log)
          if (sessionData.logs.length > MAX_SESSION_LOGS) sessionData.logs.shift()

          const webhookUrl = process.env.WEBHOOK_URL
          if (webhookUrl) {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 5000)
            const t0 = Date.now()
            try {
              const webhookSecret = process.env.WEBHOOK_SECRET
              const headers: Record<string, string> = { 'Content-Type': 'application/json' }
              if (webhookSecret) headers['Authorization'] = `Bearer ${webhookSecret}`
              const webhookRes = await fetch(webhookUrl, {
                method: 'POST', headers, signal: controller.signal,
                body: JSON.stringify({
                  userId, instanceId, from, body: rawBody,
                  type: msgTypeName, hasMedia,
                  timestamp: Math.floor(Date.now() / 1000),
                }),
              })
              const ms = Date.now() - t0
              if (!webhookRes.ok) console.error(`[${ts()}] [${userId}] [WEBHOOK] → ${webhookRes.status} (${ms}ms)`)
              else console.log(`[${ts()}] [${userId}] [WEBHOOK] → OK (${ms}ms)`)
            } catch (e: any) {
              console.error(`[${ts()}] [${userId}] [WEBHOOK] falhou (${Date.now() - t0}ms):`, e?.message ?? e)
            } finally {
              clearTimeout(timer)
            }
          }
        } catch (e: any) {
          console.error(`[${ts()}] [${userId}] [MSG] Erro ao processar mensagem:`, e?.message ?? e)
        }
      }
    })

    console.log(`[${ts()}] [${userId}] Socket Baileys inicializado`)
  })().catch(err => {
    console.error(`[${ts()}] [${userId}] Erro ao criar sessão Baileys:`, err?.message ?? err)
    activeClients.delete(userId)
  })

  return instanceId
}

// ─── GET /instance/create/:userId ────────────────────────────────────────────

app.get('/instance/create/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)

  if (activeClients.has(userId)) {
    const existing = activeClients.get(userId)!
    return res.status(200).json({
      message: 'Sessão já existe',
      status: 'existing',
      userId,
      instanceId: existing.instanceId,
      ready: existing.ready,
      authenticated: existing.authenticated,
      state: deriveState(existing),
    })
  }

  const instanceId = createSession(userId)
  res.status(200).json({
    message: `Instância '${userId}' criada com sucesso.`,
    userId,
    instanceId,
  })
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
  if (number) logs = logs.filter(l => l.number === number)
  if (sinceValid) logs = logs.filter(l => new Date(l.timestamp) > sinceDate!)

  res.json({ userId, instanceId: session.instanceId, total: logs.length, logs })
})

// ─── Instance info ────────────────────────────────────────────────────────────

app.get('/instance/chats/:userId', (_req: Request, res: Response) => {
  res.status(501).json({ ok: false, error: 'not_implemented', message: 'getChats não disponível com Baileys. Use o banco de dados do SenderWhats.' })
})

app.get('/instance/status/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const session = activeClients.get(userId)
  if (!session) {
    return res.status(404).json({
      status: 'not_found', state: null, authenticated: false, readySince: null, lastError: null,
    })
  }
  session.apiCalls++
  res.json({
    userId,
    instanceId: session.instanceId,
    status: computeSessionStatus(session),
    state: deriveState(session),
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
      state: deriveState(session), queueLength: messageQueues.get(userId)?.length || 0,
    })
  }
  res.json({ total: users.length, instances: users })
})

app.get('/instance/info/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const session = activeClients.get(userId)
  if (!session) return res.status(404).send('Sessão não encontrada.')
  session.apiCalls++
  res.json({
    userId: session.userId, instanceId: session.instanceId,
    ready: session.ready, authenticated: session.authenticated,
    state: deriveState(session), lastError: session.lastError,
    createdAt: session.createdAt, readySince: session.readyAt?.toISOString() ?? null,
    number: session.number || null, queueLength: messageQueues.get(userId)?.length || 0,
  })
})

app.post('/instance/disconnect/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const session = activeClients.get(userId)
  if (!session) return res.status(404).send('Sessão não encontrada.')
  session.apiCalls++

  console.log(`[${ts()}] [${userId}] [DISCONNECT] Desconectando...`)
  session.destroyingIntentionally = true
  try { session.sock.end(undefined) } catch {}

  activeClients.delete(userId)
  pausedNumbers.delete(userId)
  messageQueues.delete(userId)
  isSendingMessage.delete(userId)

  console.log(`[${ts()}] [${userId}] [DISCONNECT] Sessão removida — enviadas: ${session.sentMessages} | recebidas: ${session.receivedMessages}`)
  res.json({ message: `Sessão ${userId} desconectada.`, userId, instanceId: session.instanceId })
})

app.delete('/instance/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)

  const session = activeClients.get(userId)
  if (session) {
    session.destroyingIntentionally = true
    try { session.sock.end(undefined) } catch {}
    activeClients.delete(userId)
    pausedNumbers.delete(userId)
    messageQueues.delete(userId)
    isSendingMessage.delete(userId)
  }

  try {
    await pool.query('DELETE FROM baileys_sessions WHERE session_id = $1', [`baileys-${userId}`])
  } catch (e: any) {
    console.error(`[${ts()}] [${userId}] [DELETE] Erro ao remover do banco:`, e?.message)
  }

  console.log(`[${ts()}] [${userId}] [DELETE] Sessão deletada`)
  res.json({ message: `Sessão ${userId} deletada.`, userId })
})

app.all('/webhook/*splat', (_req: Request, res: Response) => {
  res.status(410).json({ ok: false, error: 'webhook_disabled' })
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
        const jid = `${number.replace(/\D/g, '')}@s.whatsapp.net`

        let sendPayload: any
        if (currentItem.media?.ptt) {
          sendPayload = {
            audio: Buffer.from(currentItem.media.base64, 'base64'),
            mimetype: currentItem.media.mimetype,
            ptt: true,
          }
        } else if (currentItem.media) {
          sendPayload = {
            image: Buffer.from(currentItem.media.base64, 'base64'),
            caption: message || undefined,
            mimetype: currentItem.media.mimetype,
          }
        } else {
          sendPayload = { text: message }
        }

        const sentMsg = await session.sock.sendMessage(jid, sendPayload)
        const whatsappMessageId = sentMsg?.key?.id ?? ''
        session.sentMessages++

        const ms = Date.now() - t0
        console.log(`[${ts()}] [${userId}] [SEND_OK] ${type} para ${number} em ${ms}ms (waId=...${whatsappMessageId.slice(-12)}) | total: ${session.sentMessages}`)

        cappedMapSet(messageRegistry, messageId, {
          userId, instanceId: session.instanceId, timestamp: new Date(),
          type: 'sent', whatsappMessageId, to: number,
        }, MAX_REGISTRY_SIZE)

        const logBody = type === 'ptt' ? `[voz: ${currentItem.media?.filename}]`
          : type === 'image' ? `[imagem: ${currentItem.media?.filename}]` : message

        session.logs.push({
          messageId, userId, instanceId: session.instanceId, number, name: number,
          body: logBody, type, direction: 'sent', timestamp: new Date(),
          media: currentItem.media ? { mimetype: currentItem.media.mimetype, filename: currentItem.media.filename } : null,
          whatsappMessageId,
        })
        if (session.logs.length > MAX_SESSION_LOGS) session.logs.shift()

        resolve({
          success: true, messageId,
          message: type === 'ptt' ? 'Áudio enviado!' : type === 'image' ? 'Imagem enviada!' : 'Mensagem enviada!',
          whatsappMessageId,
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

// ─── Helpers dos endpoints de envio ──────────────────────────────────────────

function checkSendPreconditions(session: SessionData, res: Response): boolean {
  if (!session.ready) {
    res.status(400).send('Instância não pronta.')
    return false
  }
  return true
}

function handleSendError(err: any, userId: string, label: string, session: SessionData, res: Response): void {
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
      details: "Campos 'number' e 'message' são obrigatórios.",
      example: { number: '5511999999999', message: 'Olá!' },
    })
  }

  const session = activeClients.get(userId)
  if (!session) return res.status(404).send('Sessão não encontrada.')
  session.apiCalls++

  if (!checkSendPreconditions(session, res)) return

  if (!messageQueues.has(userId)) messageQueues.set(userId, [])
  const messageId = generateUniqueId()

  const sendPromise = new Promise<SendResult>((resolve, reject) => {
    messageQueues.get(userId)?.push({ number, message, messageId, resolve, reject })
  })
  processQueue(userId)

  try {
    const result = await Promise.race([
      sendPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Tempo limite excedido.')), SEND_TIMEOUT_MS)),
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
  if (!number)    return res.status(400).json({ ok: false, error: 'invalid_payload', details: "Campo 'number' é obrigatório." })
  if (!req.file)  return res.status(400).json({ ok: false, error: 'invalid_payload', details: "Campo 'image' (arquivo) é obrigatório." })

  session.apiCalls++
  if (!checkSendPreconditions(session, res)) return

  if (!messageQueues.has(userId)) messageQueues.set(userId, [])
  const messageId = generateUniqueId()
  const base64 = req.file.buffer.toString('base64')
  const ext = req.file.mimetype.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg'
  const safeName = (req.file.originalname ?? '').trim().replace(/[/\\]/g, '').replace(/\.\./g, '')
  const filename = safeName || `image-${Date.now()}.${ext}`

  const sendPromise = new Promise<SendResult>((resolve, reject) => {
    messageQueues.get(userId)!.push({ number, message: caption, messageId, media: { base64, mimetype: req.file!.mimetype, filename }, resolve, reject })
  })
  processQueue(userId)

  try {
    const result = await Promise.race([
      sendPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Tempo limite excedido.')), SEND_TIMEOUT_MS)),
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
  if (!number)   return res.status(400).json({ ok: false, error: 'invalid_payload', details: "Campo 'number' é obrigatório." })
  if (!req.file) return res.status(400).json({ ok: false, error: 'invalid_payload', details: "Campo 'audio' (arquivo) é obrigatório." })

  session.apiCalls++
  if (!checkSendPreconditions(session, res)) return

  if (!messageQueues.has(userId)) messageQueues.set(userId, [])
  const messageId = generateUniqueId()
  const base64 = req.file.buffer.toString('base64')
  const ext = (req.file.mimetype.split('/')[1]?.split(';')[0] ?? 'ogg').replace('mpeg', 'mp3')
  const safeName = (req.file.originalname ?? '').trim().replace(/[/\\]/g, '').replace(/\.\./g, '')
  const filename = safeName || `audio-${Date.now()}.${ext}`

  const sendPromise = new Promise<SendResult>((resolve, reject) => {
    messageQueues.get(userId)!.push({ number, message: '', messageId, media: { base64, mimetype: req.file!.mimetype, filename, ptt: true }, resolve, reject })
  })
  processQueue(userId)

  try {
    const result = await Promise.race([
      sendPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Tempo limite excedido.')), SEND_TIMEOUT_MS)),
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
  res.json({ message: `IA pausada para ${number}`, userId, instanceId: session.instanceId, number, actionId: generateUniqueId() })
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
  res.json({ message: `IA retomada para ${number}`, userId, instanceId: session.instanceId, number, actionId: generateUniqueId() })
})

// ─── Mídia / mensagem por ID ──────────────────────────────────────────────────

app.get('/message/media/:userId/:whatsappMessageId', (_req: Request, res: Response) => {
  res.status(501).json({ ok: false, error: 'not_implemented', message: 'Download de mídia por ID não disponível com Baileys.' })
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
  const limit  = Math.min(isNaN(limitParsed)  ? 100 : Math.max(1, limitParsed), 500)
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
      state: deriveState(session), queueLength: messageQueues.get(userId)?.length || 0,
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
    state: deriveState(session), queueLength: messageQueues.get(userId)?.length || 0,
    cachedLogs: session.logs.length,
  })
})

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'API WhatsApp (Baileys) ativa 🚀', version: '3.0.0' })
})

// ─── Processo ─────────────────────────────────────────────────────────────────

process.on('uncaughtException', (err: Error) => {
  console.error(`[${ts()}] [PROCESSO] Exceção não capturada:`, err.message)
})

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error(`[${ts()}] [PROCESSO] Rejeição não tratada:`, msg)
})

async function gracefulShutdown(signal: string) {
  console.log(`[${ts()}] [SHUTDOWN] Sinal ${signal} — encerrando ${activeClients.size} sessão(ões)...`)
  for (const [userId, session] of activeClients.entries()) {
    session.destroyingIntentionally = true
    try { session.sock.end(undefined); console.log(`[${ts()}] [SHUTDOWN] ${userId} encerrado`) } catch {}
  }
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT',  () => gracefulShutdown('SIGINT'))

// ─── Startup ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080

async function start() {
  await initDatabase()

  app.listen(PORT, async () => {
    console.log(`[${ts()}] [STARTUP] Backend WhatsApp (Baileys) rodando na porta ${PORT}`)
    console.log(`[${ts()}] [STARTUP] Hostname:        ${hostname()}`)
    console.log(`[${ts()}] [STARTUP] API_KEY:         ${API_KEY ? 'configurada ✓' : 'NÃO CONFIGURADA ⚠'}`)
    console.log(`[${ts()}] [STARTUP] WEBHOOK_URL:     ${process.env.WEBHOOK_URL || 'não configurada'}`)
    console.log(`[${ts()}] [STARTUP] WEBHOOK_SECRET:  ${process.env.WEBHOOK_SECRET ? 'configurado ✓' : 'não configurado'}`)
    console.log(`[${ts()}] [STARTUP] SENDERWHATS_URL: ${process.env.SENDERWHATS_URL || 'não configurada'}`)
    console.log(`[${ts()}] [STARTUP] DATABASE_URL:    ${process.env.DATABASE_URL ? 'configurada ✓' : 'NÃO CONFIGURADA ⚠'}`)

    const toRecover = await loadPersistedSessions()
    if (toRecover.length === 0) {
      console.log(`[${ts()}] [STARTUP] Nenhuma sessão no banco para recuperar`)
    } else {
      console.log(`[${ts()}] [STARTUP] Recuperando ${toRecover.length} sessão(ões): ${toRecover.join(', ')}`)
      toRecover.forEach((uid: string, index: number) => {
        setTimeout(() => {
          console.log(`[${ts()}] [STARTUP] Iniciando recuperação de: ${uid}`)
          createSession(uid)
        }, index * 3_000)
      })
    }
  })
}

start().catch(err => {
  console.error(`[${ts()}] [STARTUP] Falha fatal ao iniciar:`, err)
  process.exit(1)
})
