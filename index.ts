import express, { type Request, type Response } from "express"
import { Client, LocalAuth, MessageMedia } from "whatsapp-web.js"
import cors from "cors"
import qrcode from "qrcode"
import multer from "multer"
import * as nodeCrypto from "node:crypto"

const app = express()
app.use(cors())
app.use(express.json())

type MediaLog = {
  mimetype: string
  filename: string
  data?: string  // base64 — presente apenas em mídia recebida (PTT, etc.)
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
  media?: { base64: string; mimetype: string; filename: string }
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
  sentMessages: number
  receivedMessages: number
  apiCalls: number
  number?: string
}

function generateUniqueId() {
  return nodeCrypto.randomUUID()
}

const activeClients = new Map<string, SessionData>() // userId → sessão ativa
const pausedNumbers = new Map<string, Set<string>>() // userId => números pausados
const messageQueues = new Map<string, QueueItem[]>() // userId => fila de envio
const isSendingMessage = new Map<string, boolean>() // userId => envio em andamento
const messageRegistry = new Map<string, RegistryPayload>() // messageId => metadados

const MAX_REGISTRY_SIZE = 5000 // ~2.5 MB máximo; cobre ~50 min a 100 msgs/min
const MAX_SESSION_LOGS = 1000  // por sessão; cobre ~20h a 50 msgs recebidas/hora

const WHATSAPP_MEDIA_LIMIT_MB = 16  // limite oficial do WhatsApp para mídia
const SEND_TIMEOUT_MS = 60_000     // 60s — cobre texto e imagem na mesma fila
const ALLOWED_IMAGE_MIMETYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp'
])

const upload = multer({
  storage: multer.memoryStorage(), // arquivo em RAM — sem disco, ideal para containers
  limits: { fileSize: WHATSAPP_MEDIA_LIMIT_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIMETYPES.has(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error(`Tipo não suportado: ${file.mimetype}. Use JPEG, PNG, GIF ou WebP.`))
    }
  }
})

// Insere no Map respeitando o cap FIFO — O(1) graças à insertion-order do Map em JS
function cappedMapSet<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  map.set(key, value)
  if (map.size > maxSize) {
    map.delete(map.keys().next().value as K)
  }
}

function getParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ""
  return value ?? ""
}

async function syncSessionReadiness(session: SessionData): Promise<string | null> {
  try {
    const state = await session.client.getState().catch(() => null)
    session.lastKnownState = state
    if (state === "CONNECTED") {
      session.ready = true
      session.authenticated = true
    } else if (state !== null) {
      // Estado conhecido mas não CONNECTED → definitivamente não está pronto
      session.ready = false
    }
    // state === null: getState() falhou, mantém o valor cacheado
    return state
  } catch (err) {
    session.lastError = err instanceof Error ? err.message : String(err)
    return null
  }
}

app.get('/instance/create/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId);

  if (activeClients.has(userId)) {
    return res.status(400).send('Já existe uma sessão para este usuário.');
  }

  // Gera um ID único para a instância
  const instanceId = generateUniqueId();

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: require('puppeteer').executablePath()
    }
  });

  const sessionData: SessionData = {
    client,
    qrCode: null,
    ready: false,
    authenticated: false,
    lastKnownState: null,
    lastError: null,
    userId,
    instanceId, // ID único da instância
    logs: [],
    createdAt: new Date(),
    sentMessages: 0,
    receivedMessages: 0,
    apiCalls: 0
  };

  client.on('qr', (qr: string) => {
    qrcode.toDataURL(qr, (err: Error | null | undefined, url: string) => {
      if (err) {
        console.error('Erro ao gerar QR Code:', err);
        return;
      }
      sessionData.qrCode = url;
    });
  });

  client.on('ready', () => {
    sessionData.ready = true;
    sessionData.authenticated = true;
    sessionData.lastKnownState = "CONNECTED";
    sessionData.lastError = null;
    sessionData.number = client.info.wid.user;
    console.log(`[${userId}] Pronto - Número conectado: ${sessionData.number}`);
    console.log(`[${userId}] Instance ID: ${instanceId}`);
  });

  client.on('authenticated', () => {
    sessionData.authenticated = true;
    sessionData.lastError = null;
    console.log(`[${userId}] Autenticado`);
  });

  client.on("auth_failure", (message: string) => {
    sessionData.ready = false
    sessionData.authenticated = false
    sessionData.lastError = message || "auth_failure"
    console.error(`[${userId}] Falha de autenticação: ${message}`)
  })

  client.on("change_state", (state: string) => {
    sessionData.lastKnownState = state
    if (state === "CONNECTED") {
      sessionData.ready = true
      sessionData.authenticated = true
    }
    if (state === "UNPAIRED" || state === "UNPAIRED_IDLE" || state === "DISCONNECTED") {
      sessionData.ready = false
    }
  })

  client.on("disconnected", (reason: string) => {
    sessionData.ready = false
    sessionData.authenticated = false
    sessionData.lastKnownState = "DISCONNECTED"
    sessionData.lastError = reason || null
    console.warn(`[${userId}] Desconectado: ${reason}`)
  })

  client.on('message', async (msg: any) => {
    sessionData.receivedMessages++;

    const contact = await msg.getContact();

    // Gera ID único para cada mensagem recebida
    const messageId = generateUniqueId();

    cappedMapSet(messageRegistry, messageId, {
      userId,
      instanceId,
      timestamp: new Date(),
      type: 'received',
      whatsappMessageId: msg.id._serialized
    }, MAX_REGISTRY_SIZE);

    const log: MessageLog = {
      messageId,
      userId,
      instanceId,
      number: msg.from,
      name: contact.pushname || contact.name || contact.number,
      body: msg.body,
      type: msg.type,
      direction: 'received',
      timestamp: new Date(),
      media: null,
      whatsappMessageId: msg.id._serialized
    };

    if (msg.hasMedia && msg.type === 'ptt') {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          log.media = {
            mimetype: media.mimetype,
            data: media.data,
            filename: `audio-${Date.now()}.ogg`
          };
        }
      } catch (err: any) {
        console.error(`Erro ao baixar mídia: ${err?.message}`);
      }
    }

    sessionData.logs.push(log)
    if (sessionData.logs.length > MAX_SESSION_LOGS) sessionData.logs.shift()

    const isPaused = pausedNumbers.get(userId)?.has(msg.from);

    if (isPaused) {
      console.log(`[IA PAUSADA] Mensagem de ${msg.from} ignorada pela IA.`);
    }
  });

  client.initialize();
  activeClients.set(userId, sessionData);

  res.status(200).json({
    message: `Instância '${userId}' criada com sucesso.`,
    userId,
    instanceId
  });
});

app.get('/messages/log/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)
  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;

  const direction = getParam(req.query.direction as string | undefined)
  const logs = direction === 'sent' || direction === 'received'
    ? session.logs.filter(l => l.direction === direction)
    : session.logs

  res.json({
    userId,
    instanceId: session.instanceId,
    total: logs.length,
    logs
  });
});

app.get('/instance/chats/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId);
  const session = activeClients.get(userId);

  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;

  await syncSessionReadiness(session)
  if (!session.ready) return res.status(400).send('Instância não pronta.');

  try {
    const chats = await session.client.getChats();

    const list = chats.map((chat: { id: { _serialized: string; user?: string }; name?: string; formattedTitle?: string }) => ({
      id: chat.id._serialized,
      name: chat.name || chat.formattedTitle || chat.id.user
    }));

    res.json({
      userId,
      instanceId: session.instanceId,
      total: list.length,
      chats: list
    });
  } catch (err: any) {
    console.error(err);
    res.status(500).send('Erro ao buscar chats.');
  }
});

app.get('/instance/status/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId);
  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;
  await syncSessionReadiness(session)

  res.json({
    userId,
    instanceId: session.instanceId,
    status: session.ready ? 'ready' : 'not_ready',
    state: session.lastKnownState,
    authenticated: session.authenticated,
    message: session.ready ? 'Client is ready.' : 'Client not initialized.',
    lastError: session.lastError
  });
});

app.get('/instance/qr/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId);
  const session = activeClients.get(userId);
  if (!session || !session.qrCode) return res.status(404).send('QR Code não disponível.');
  session.apiCalls++;

  res.json({
    userId,
    instanceId: session.instanceId,
    qrCode: session.qrCode
  });
});

app.get('/instance/active', (_req: Request, res: Response) => {
  const users = []

  for (const [userId, session] of activeClients.entries()) {
    users.push({
      userId,
      instanceId: session.instanceId,
      number: session.number || null,
      ready: session.ready,
      authenticated: session.authenticated,
      state: session.lastKnownState,
      queueLength: messageQueues.get(userId)?.length || 0
    });
  }

  res.json({ total: users.length, instances: users });
});

app.get('/instance/info/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId);
  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;

  await syncSessionReadiness(session)

  res.json({
    userId: session.userId,
    instanceId: session.instanceId,
    ready: session.ready,
    authenticated: session.authenticated,
    state: session.lastKnownState,
    lastError: session.lastError,
    createdAt: session.createdAt,
    number: session.number || null,
    queueLength: messageQueues.get(userId)?.length || 0
  });
});

app.post('/instance/disconnect/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId);
  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;

  try {
    await session.client.logout();
    await session.client.destroy();
  } catch {
    // ignora erros de logout/destroy — sessão pode já estar morta
  }

  activeClients.delete(userId)
  pausedNumbers.delete(userId)
  messageQueues.delete(userId)
  isSendingMessage.delete(userId)

  res.json({
    message: `Sessão ${userId} desconectada.`,
    userId,
    instanceId: session.instanceId
  });
});

app.all('/webhook/*splat', (_req: Request, res: Response) => {
  res.status(410).json({
    ok: false,
    error: "webhook_disabled",
    message: "Endpoints de webhook/n8n foram desativados neste projeto.",
  })
})

async function processQueue(userId: string) {
  if (isSendingMessage.get(userId)) return;

  const session = activeClients.get(userId);
  if (!session || !session.ready) return;

  const queue = messageQueues.get(userId);
  if (!queue || queue.length === 0) return;

  isSendingMessage.set(userId, true);

  try {
    while (queue.length > 0) {
      const currentItem = queue.shift()
      if (!currentItem) continue
      const { number, message, messageId, resolve, reject } = currentItem;

      try {
        // getNumberId resolve o LID para contas na nova infra do WhatsApp (evita "No LID for user")
        const numberId = await session.client.getNumberId(number);

        if (!numberId) {
          console.error(`[${userId}] Número inválido ou não registrado no WhatsApp: ${number}`);
          reject(new Error(`Número ${number} não possui WhatsApp.`));
          continue;
        }

        const chatId = numberId._serialized;

        const sendPayload: string | MessageMedia = currentItem.media
          ? new MessageMedia(
              currentItem.media.mimetype,
              currentItem.media.base64,
              currentItem.media.filename
            )
          : message

        // sendSeen: false evita o crash interno de 'markedUnread' no WhatsApp Web
        const sentMessage = await session.client.sendMessage(chatId, sendPayload, { sendSeen: false });
        session.sentMessages += 1;

        cappedMapSet(messageRegistry, messageId, {
          userId,
          instanceId: session.instanceId,
          timestamp: new Date(),
          type: 'sent',
          whatsappMessageId: sentMessage.id._serialized,
          to: number
        }, MAX_REGISTRY_SIZE);

        session.logs.push({
          messageId,
          userId,
          instanceId: session.instanceId,
          number,
          name: number,
          body: currentItem.media ? `[imagem: ${currentItem.media.filename}]` : message,
          type: currentItem.media ? 'image' : 'chat',
          direction: 'sent',
          timestamp: new Date(),
          media: currentItem.media
            ? { mimetype: currentItem.media.mimetype, filename: currentItem.media.filename }
            : null,
          whatsappMessageId: sentMessage.id._serialized
        })
        if (session.logs.length > MAX_SESSION_LOGS) session.logs.shift()

        resolve({
          success: true,
          messageId,
          message: currentItem.media ? 'Imagem enviada!' : 'Mensagem enviada!',
          whatsappMessageId: sentMessage.id._serialized
        });
      } catch (err: any) {
        console.error(`[${userId}] Erro ao enviar mensagem para ${number}:`, err);
        reject(new Error(`Falha ao enviar mensagem para ${number}: ${err.message}`));
      }
    }
  } finally {
    isSendingMessage.set(userId, false);
  }
}

app.post('/message/send-text/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId);
  const body = (req.body ?? {}) as { number?: unknown; message?: unknown }
  const number = String(body.number ?? "").trim()
  const message = String(body.message ?? "").trim()

  if (!number || !message) {
    return res.status(400).json({
      ok: false,
      error: "invalid_payload",
      details: "Campos 'number' e 'message' são obrigatórios no JSON body.",
      example: { number: "5511999999999", message: "Olá!" },
    })
  }

  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;

  await syncSessionReadiness(session)
  if (!session.ready) return res.status(400).send('Instância não pronta.');

  if (!messageQueues.has(userId)) {
    messageQueues.set(userId, []);
  }

  const messageId = generateUniqueId();

  const sendPromise = new Promise<SendResult>((resolve, reject) => {
    messageQueues.get(userId)?.push({ number, message, messageId, resolve, reject });
  });

  processQueue(userId);

  try {
    const result: SendResult = await Promise.race([
      sendPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Tempo limite excedido. Tente novamente.')), SEND_TIMEOUT_MS)
      )
    ])
    res.json({
      ...result,
      userId,
      instanceId: session.instanceId
    });
  } catch (err: any) {
    console.error('Erro no envio de mensagem:', err);
    const errorMessage = err instanceof Error ? err.message : String(err)
    res.status(500).json({
      error: 'Erro ao enviar mensagem.',
      details: errorMessage,
      userId,
      instanceId: session.instanceId
    });
  }
});

app.post('/message/send-image/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId)

  // Valida a sessão antes de consumir o upload — evita alocar buffer de até 16MB para userId inválido
  const session = activeClients.get(userId)
  if (!session) return res.status(404).send('Sessão não encontrada.')

  try {
    await new Promise<void>((resolve, reject) => {
      upload.single('image')(req, res, (err: unknown) => (err ? reject(err) : resolve()))
    })
  } catch (err: any) {
    const isSizeError = err?.code === 'LIMIT_FILE_SIZE'
    return res.status(400).json({
      ok: false,
      error: 'invalid_file',
      details: isSizeError
        ? `Arquivo muito grande. Máximo ${WHATSAPP_MEDIA_LIMIT_MB}MB.`
        : err.message ?? 'Arquivo inválido.'
    })
  }

  const number = String(req.body.number ?? '').trim()
  const caption = String(req.body.caption ?? '').trim()

  if (!number) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_payload',
      details: "Campo 'number' é obrigatório.",
      example: { number: '5511999999999' }
    })
  }

  if (!req.file) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_payload',
      details: "Campo 'image' (arquivo) é obrigatório."
    })
  }

  session.apiCalls++

  await syncSessionReadiness(session)
  if (!session.ready) return res.status(400).send('Instância não pronta.')

  if (!messageQueues.has(userId)) messageQueues.set(userId, [])

  const messageId = generateUniqueId()
  const base64 = req.file.buffer.toString('base64')
  const ext = req.file.mimetype.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg'
  // Remove separadores de caminho do nome original para evitar sequências como "../../"
  const safeName = (req.file.originalname ?? '').trim().replace(/[/\\]/g, '').replace(/\.\./g, '').trim()
  const filename = safeName || `image-${Date.now()}.${ext}`

  const sendPromise = new Promise<SendResult>((resolve, reject) => {
    messageQueues.get(userId)!.push({
      number,
      message: caption,
      messageId,
      media: { base64, mimetype: req.file!.mimetype, filename },
      resolve,
      reject
    })
  })

  processQueue(userId)

  try {
    const result = await Promise.race([
      sendPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Tempo limite excedido. Tente novamente.')), SEND_TIMEOUT_MS)
      )
    ])
    res.json({ ...result, userId, instanceId: session.instanceId })
  } catch (err: any) {
    console.error(`[${userId}] Erro ao enviar imagem para ${number}:`, err)
    const errorMessage = err instanceof Error ? err.message : String(err)
    res.status(500).json({
      error: 'Erro ao enviar imagem.',
      details: errorMessage,
      userId,
      instanceId: session.instanceId
    })
  }
})

app.post('/ia/pause/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId);
  const { number } = req.body;

  if (!number) return res.status(400).send('Número é obrigatório.');

  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;

  if (!pausedNumbers.has(userId)) pausedNumbers.set(userId, new Set());
  pausedNumbers.get(userId)!.add(number);

  res.json({
    message: `Atendimento da IA pausado para ${number} em ${userId}`,
    userId,
    instanceId: session.instanceId,
    number,
    actionId: generateUniqueId()
  });
});

app.get('/message/media/:userId/:whatsappMessageId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId);
  const whatsappMessageId = getParam(req.params.whatsappMessageId);

  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;

  await syncSessionReadiness(session)
  if (!session.ready) return res.status(400).send('Instância não pronta.');

  try {
    const message = await session.client.getMessageById(whatsappMessageId);

    if (!message.hasMedia) {
      return res.status(400).send('Esta mensagem não contém mídia.');
    }

    const media = await message.downloadMedia();
    if (!media) {
      return res.status(404).send('Falha ao baixar mídia da mensagem.');
    }
    const mediaId = generateUniqueId();
    const messageData = message as unknown as { _data?: { filename?: string } }

    res.json({
      mediaId,
      whatsappMessageId,
      userId,
      instanceId: session.instanceId,
      mimetype: media.mimetype,
      data: media.data,
      filename: messageData._data?.filename || null
    });
  } catch (err: any) {
    console.error(`[${userId}] Erro ao obter mídia:`, err);
    res.status(500).send(`Erro ao obter mídia: ${err?.message}`);
  }
});

app.get('/messages/sent/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId);
  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;

  res.json({
    userId,
    instanceId: session.instanceId,
    sentMessages: session.sentMessages
  });
});

app.post('/ia/resume/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId);
  const { number } = req.body;

  if (!number) return res.status(400).send('Número é obrigatório.');

  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;

  pausedNumbers.get(userId)?.delete(number);

  res.json({
    message: `Atendimento da IA retomado para ${number} em ${userId}`,
    userId,
    instanceId: session.instanceId,
    number,
    actionId: generateUniqueId()
  });
});

app.get('/instance/insights', (_req: Request, res: Response) => {
  const insights = []

  for (const [userId, session] of activeClients.entries()) {
    insights.push({
      userId,
      instanceId: session.instanceId,
      createdAt: session.createdAt,
      ready: session.ready,
      number: session.number || null,
      totalApiCalls: session.apiCalls,
      sentMessages: session.sentMessages,
      receivedMessages: session.receivedMessages,
      authenticated: session.authenticated,
      state: session.lastKnownState,
      queueLength: messageQueues.get(userId)?.length || 0,
      cachedLogs: session.logs.length
    });
  }

  res.json({ total: insights.length, insights });
});

app.get('/instance/insights/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId);
  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');

  session.apiCalls++;

  res.json({
    userId: session.userId,
    instanceId: session.instanceId,
    createdAt: session.createdAt,
    ready: session.ready,
    number: session.number || null,
    totalApiCalls: session.apiCalls,
    sentMessages: session.sentMessages,
    receivedMessages: session.receivedMessages,
    authenticated: session.authenticated,
    state: session.lastKnownState,
    queueLength: messageQueues.get(userId)?.length || 0,
    cachedLogs: session.logs.length
  });
});

// Nova rota para buscar mensagem por ID
app.get('/message/:messageId', (req: Request, res: Response) => {
  const messageId = getParam(req.params.messageId);
  const messageInfo = messageRegistry.get(messageId);

  if (!messageInfo) {
    return res.status(404).json({ error: 'Mensagem não encontrada.' });
  }

  res.json({
    messageId,
    data: messageInfo
  });
});

app.get('/messages/registry', (req: Request, res: Response) => {
  const limitParsed = parseInt(getParam(req.query.limit as string | undefined), 10)
  const offsetParsed = parseInt(getParam(req.query.offset as string | undefined), 10)
  const limit = Math.min(isNaN(limitParsed) ? 100 : Math.max(1, limitParsed), 500)
  const offset = isNaN(offsetParsed) ? 0 : Math.max(0, offsetParsed)

  const all = Array.from(messageRegistry.entries()).map(([messageId, data]) => ({ messageId, data }))
  const page = all.slice(offset, offset + limit)

  res.json({
    total: all.length,
    limit,
    offset,
    messages: page
  });
});

app.get('/', (_req: Request, res: Response) => {
  res.json({
    message: 'API WhatsApp ativa 🚀',
    version: '2.0.0',
    features: ['Unique IDs', 'Message Registry', 'Instance Tracking', 'Webhook Disabled']
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend multi-sessão com IDs únicos rodando na porta ${PORT}`));