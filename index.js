import express, { type Request, type Response } from "express"
import { Client, LocalAuth, MessageMedia } from "whatsapp-web.js"
import cors from "cors"
import qrcode from "qrcode"
import * as nodeCrypto from "node:crypto"

const app = express()
app.use(cors())
app.use(express.json())

type MediaLog = {
  mimetype: string
  data: string
  filename: string
}

type MessageLog = {
  messageId: string
  userId: string
  instanceId: string
  number: string
  name: string
  body: string
  type: string
  timestamp: Date
  media: MediaLog | null
  whatsappMessageId: string
}

type RegistryPayload = Record<string, unknown>

type QueueItem = {
  number: string
  message: string
  messageId: string
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

// Função para gerar ID Único
function generateUniqueId() {
  return nodeCrypto.randomUUID()
}

function generateTimestampId() {
  return `${Date.now()}-${nodeCrypto.randomBytes(8).toString("hex")}`
}

const activeClients = new Map < string, SessionData> () // userId → sessão ativa
const pausedNumbers = new Map < string, Set<string>>() // userId => números pausados
  const messageQueues = new Map<string, QueueItem[]>() // userId => fila de envio
  const isSendingMessage = new Map<string, boolean>() // userId => envio em andamento
  const messageRegistry = new Map<string, RegistryPayload>() // messageId => metadados

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
    }
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
    authStrategy: new LocalAuth({clientId: userId }),
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

  // Registra a mensagem no registry global
  messageRegistry.set(messageId, {
    userId,
    instanceId,
    timestamp: new Date(),
  type: 'received',
  whatsappMessageId: msg.id._serialized
    });

  const log: MessageLog = {
    messageId, // ID único da mensagem
    userId, // ID do usuário
    instanceId, // ID da instância
    number: msg.from,
  name: contact.pushname || contact.name || contact.number,
  body: msg.body,
  type: msg.type,
  timestamp: new Date(),
  media: null,
  whatsappMessageId: msg.id._serialized // ID original do WhatsApp
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

  sessionData.logs.push(log);

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
  res.json({
    userId,
    instanceId: session.instanceId,
  logs: session.logs
  });
});

app.get('/instance/chats/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId);
  const session = activeClients.get(userId);

  if (!session) {
    return res.status(400).send('Instância não pronta ou não existe.');
  }
  await syncSessionReadiness(session)
  if (!session.ready) {
    if (session) session.apiCalls++;
  return res.status(400).send('Instância não pronta ou não existe.');
  }
  session.apiCalls++;

  try {
    const chats = await session.client.getChats();
  const total = chats.length;

  const nomes = chats.map((chat: {id: {_serialized: string; user?: string }; name?: string; formattedTitle?: string }) => ({
    id: chat.id._serialized,
  name: chat.name || chat.formattedTitle || chat.id.user,
  chatId: generateUniqueId() // ID único para cada chat
    }));

  res.json({
    userId,
    instanceId: session.instanceId,
  total,
  chats: nomes 
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
  const users: Array<{
    userId: string
  instanceId: string
  ready: boolean
  authenticated: boolean
  state: string | null
  mensagensNaFila: number
  conectado: boolean
  }> = [];

  for (const [userId, session] of activeClients.entries()) {
    users.push({
      userId,
      instanceId: session.instanceId,
      ready: session.ready,
      authenticated: session.authenticated,
      state: session.lastKnownState,
      mensagensNaFila: messageQueues.get(userId)?.length || 0,
      conectado: session.ready ? true : false
    });
  }

  res.json(users);
});

app.get('/instance/info/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId);
  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;

  res.json({
    userId: session.userId,
  instanceId: session.instanceId,
  ready: session.ready,
  authenticated: session.authenticated,
  state: session.lastKnownState,
  lastError: session.lastError,
  createdAt: session.createdAt,
  number: session.number || null,
  mensagensNaFila: messageQueues.get(userId)?.length || 0
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
  activeClients.delete(userId);

  res.json({
    message: `Sessão ${userId} desconectada.`,
  userId,
  instanceId: session.instanceId
    });
  } catch (err: any) {
    res.status(500).send('Erro ao desconectar.');
  }
});

app.all('/webhook/:rest*', (_req: Request, res: Response) => {
    res.status(410).json({
      ok: false,
      error: "webhook_disabled",
      message: "Endpoints de webhook/n8n foram desativados neste projeto.",
    })
  })

  function calcularTempoDigitacao(texto: string) {
  const caracteresPorSegundo = 16;
  const tempo = Math.ceil(texto.length / caracteresPorSegundo) * 1000;
  return Math.min(tempo, 15000);
}

  function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

  async function processQueue(userId: string) {
  if (isSendingMessage.get(userId)) return;

  const session = activeClients.get(userId);
  if (!session || !session.ready) return;

  const queue = messageQueues.get(userId);
  if (!queue || queue.length === 0) return;

  isSendingMessage.set(userId, true);

  while (queue.length > 0) {
    const currentItem = queue.shift()
  if (!currentItem) continue
  const {number, message, messageId, resolve, reject} = currentItem;

  try {
      const chatId = `${number}@c.us`;
  const isRegistered = await session.client.isRegisteredUser(chatId);

  if (!isRegistered) {
    console.error(`[${userId}] Número inválido ou não registrado no WhatsApp: ${number}`);
  reject(new Error(`Número ${number} não possui WhatsApp.`));
  continue;
      }

  const chat = await session.client.getChatById(chatId);
  const tempoDigitacao = calcularTempoDigitacao(message);

  await chat.sendStateTyping();
  await delay(tempoDigitacao);
  await chat.clearState();

  const sentMessage = await session.client.sendMessage(chatId, message);
  session.sentMessages += 1;

  // Registra a mensagem enviada
  messageRegistry.set(messageId, {
    userId,
    instanceId: session.instanceId,
  timestamp: new Date(),
  type: 'sent',
  whatsappMessageId: sentMessage.id._serialized,
  to: number
      });

  resolve({
    success: true,
  messageId,
  message: 'Mensagem enviada!',
  whatsappMessageId: sentMessage.id._serialized
      });
    } catch (err: any) {
    console.error(`[${userId}] Erro ao enviar mensagem para ${number}:`, err);
  reject(new Error(`Falha ao enviar mensagem para ${number}: ${err.message}`));
    }
  }

  isSendingMessage.set(userId, false);
}

app.post('/message/send-text/:userId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId);
  const {number, message} = req.body;

  const session = activeClients.get(userId);
  if (!session) {
    return res.status(400).send('Client não pronto.');
  }
  await syncSessionReadiness(session)
  if (!session.ready) return res.status(400).send('Client não pronto.');

  if (!messageQueues.has(userId)) {
    messageQueues.set(userId, []);
  }

  // Gera ID único para a mensagem que será enviada
  const messageId = generateUniqueId();

  const sendPromise = new Promise<SendResult>((resolve, reject) => {
    messageQueues.get(userId)?.push({ number, message, messageId, resolve, reject });
  });

    processQueue(userId);

    try {
    const result: SendResult = await sendPromise;
    session.apiCalls++;
    res.json({
      ...result,
      userId,
      instanceId: session.instanceId
    });
  } catch (err: any) {
      console.error('Erro no envio de mensagem:', err);
    res.status(500).json({
      error: 'Erro ao enviar mensagem.',
    userId,
    instanceId: session.instanceId
    });
  }
});

app.post('/ia/pause/:userId', (req: Request, res: Response) => {
  const userId = getParam(req.params.userId);
    const {number} = req.body;

    if (!number) return res.status(400).send('Número é obrigatório.');

    const session = activeClients.get(userId);
    if (session) session.apiCalls++;

    if (!pausedNumbers.has(userId)) {
      pausedNumbers.set(userId, new Set());
  }

    pausedNumbers.get(userId)?.add(number);

    res.json({
      message: `Atendimento da IA pausado para ${number} em ${userId}`,
    userId,
    instanceId: session?.instanceId,
    number,
    actionId: generateUniqueId()
  });
});

app.get('/message/media/:userId/:messageId', async (req: Request, res: Response) => {
  const userId = getParam(req.params.userId);
    const messageId = getParam(req.params.messageId);

    const session = activeClients.get(userId);
    if (!session) {
    return res.status(400).send('Client não pronto ou não existe.');
  }
    await syncSessionReadiness(session)
    if (!session.ready) {
      session.apiCalls++;
    return res.status(400).send('Client não pronto ou não existe.');
  }

    session.apiCalls++;

    try {
    const message = await session.client.getMessageById(messageId);

    if (!message.hasMedia) {
      return res.status(400).send('Esta mensagem não contém mídia.');
    }

    const media = await message.downloadMedia();
    if (!media) {
      return res.status(404).send('Falha ao baixar mídia da mensagem.');
    }
    const mediaId = generateUniqueId();
    const messageData = message as unknown as {_data ?: { filename?: string }}

    res.json({
      mediaId,
      messageId,
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
    const {number} = req.body;

    if (!number) return res.status(400).send('Número é obrigatório.');

    const session = activeClients.get(userId);
    if (session) session.apiCalls++;

    const userPaused = pausedNumbers.get(userId);
    if (userPaused) {
      userPaused.delete(number);
  }

    res.json({
      message: `Atendimento da IA retomado para ${number} em ${userId}`,
    userId,
    instanceId: session?.instanceId,
    number,
    actionId: generateUniqueId()
  });
});

app.get('/instance/insights', (_req: Request, res: Response) => {
  const insights: Array<{
    userId: string
    instanceId: string
    createdAt: Date
    ready: boolean
    number: string | null
    totalApiCalls: number
    sentMessages: number
    receivedMessages: number
    authenticated: boolean
    state: string | null
    queueLength: number
    totalLogs: number
  }> = [];

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
        totalLogs: session.logs.length
      });
  }

    res.json(insights);
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
    totalLogs: session.logs.length
  });
});

// Nova rota para buscar mensagem por ID
app.get('/message/:messageId', (req: Request, res: Response) => {
  const messageId = getParam(req.params.messageId);
    const messageInfo = messageRegistry.get(messageId);

    if (!messageInfo) {
    return res.status(404).json({error: 'Mensagem não encontrada.' });
  }

    res.json({
      messageId,
      data: messageInfo
  });
});

// Nova rota para listar todas as mensagens registradas
app.get('/messages/registry', (_req: Request, res: Response) => {
  const messages: Array<{ messageId: string; data: RegistryPayload }> = [];

    for (const [messageId, info] of messageRegistry.entries()) {
      messages.push({
        messageId,
        data: info
      });
  }

    res.json({
      total: messages.length,
    messages
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