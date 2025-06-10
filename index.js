const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const cors = require('cors');
const qrcode = require('qrcode');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// Função para gerar ID único
function generateUniqueId() {
  return crypto.randomUUID();
}

// Função para gerar ID único baseado em timestamp + random (alternativa)
function generateTimestampId() {
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

const activeClients = new Map(); // userId → { client, qr, ready, webhookUrl }
const pausedNumbers = new Map(); // userId => Set de números pausados
const messageQueues = new Map(); // userId => array de mensagens { number, message }
const isSendingMessage = new Map(); // userId => booleano de controle de envio
const messageRegistry = new Map(); // messageId => { userId, timestamp, type }

app.get('/instance/create/:userId', (req, res) => {
  const { userId } = req.params;
  
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

  const sessionData = {
    client,
    qrCode: null,
    ready: false,
    webhookUrl: null,
    userId, 
    instanceId, // ✅ ID único da instância
    logs: [],
    createdAt: new Date(),
    sentMessages: 0,
    receivedMessages: 0,
    webhookCalls: 0,
    apiCalls: 0
  };

  client.on('qr', (qr) => {
    qrcode.toDataURL(qr, (err, url) => {
      if (err) {
        console.error('Erro ao gerar QR Code:', err);
        return;
      }
      sessionData.qrCode = url;
    });
  });

  client.on('ready', () => {
    sessionData.ready = true;
    sessionData.number = client.info.wid.user;
    console.log(`[${userId}] Pronto - Número conectado: ${sessionData.number}`);
    console.log(`[${userId}] Instance ID: ${instanceId}`);
  });

  client.on('authenticated', () => {
    console.log(`[${userId}] Autenticado`);
  });

  client.on('message', async (msg) => {
    sessionData.receivedMessages++;
    
    const contact = await msg.getContact();
    
    // ✅ Gera ID único para cada mensagem recebida
    const messageId = generateUniqueId();
    
    // ✅ Registra a mensagem no registry global
    messageRegistry.set(messageId, {
      userId,
      instanceId,
      timestamp: new Date(),
      type: 'received',
      whatsappMessageId: msg.id._serialized
    });

    const log = {
      messageId, // ✅ ID único da mensagem
      userId, // ✅ ID do usuário
      instanceId, // ✅ ID da instância
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
      } catch (err) {
        console.error(`Erro ao baixar mídia: ${err.message}`);
      }
    }

    sessionData.logs.push(log);

    const isPaused = pausedNumbers.get(userId)?.has(msg.from);

    if (isPaused) {
      console.log(`[IA PAUSADA] Mensagem de ${msg.from} ignorada pela IA.`);
    } else if (sessionData.webhookUrl) {
      try {
        await axios.post(sessionData.webhookUrl, { ...log, userId });
        sessionData.webhookCalls++;
      } catch (err) {
        console.error(`Erro no webhook de ${userId}: ${err.message}`);
      }
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

app.get('/messages/log/:userId', (req, res) => {
  const session = activeClients.get(req.params.userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;
  res.json({
    userId: req.params.userId,
    instanceId: session.instanceId,
    logs: session.logs
  });
});

app.get('/instance/chats/:userId', async (req, res) => {
  const { userId } = req.params;
  const session = activeClients.get(userId);

  if (!session || !session.ready) {
    if (session) session.apiCalls++;
    return res.status(400).send('Instância não pronta ou não existe.');
  }

  session.apiCalls++;

  try {
    const chats = await session.client.getChats();
    const total = chats.length;

    const nomes = chats.map(chat => ({
      id: chat.id._serialized,
      name: chat.name || chat.formattedTitle || chat.id.user,
      chatId: generateUniqueId() // ✅ ID único para cada chat
    }));

    res.json({ 
      userId,
      instanceId: session.instanceId,
      total, 
      chats: nomes 
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao buscar chats.');
  }
});

app.get('/instance/status/:userId', (req, res) => {
  const { userId } = req.params;
  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;
  
  res.json({
    userId,
    instanceId: session.instanceId,
    status: session.ready ? 'ready' : 'not_ready',
    message: session.ready ? 'Client is ready.' : 'Client not initialized.'
  });
});

app.get('/instance/qr/:userId', (req, res) => {
  const { userId } = req.params;
  const session = activeClients.get(userId);
  if (!session || !session.qrCode) return res.status(404).send('QR Code não disponível.');
  session.apiCalls++;
  
  res.json({
    userId,
    instanceId: session.instanceId,
    qrCode: session.qrCode
  });
});

app.get('/instance/active', (req, res) => {
  const users = [];

  for (const [userId, session] of activeClients.entries()) {
    users.push({
      userId,
      instanceId: session.instanceId,
      ready: session.ready,
      webhookUrl: session.webhookUrl || null,
      mensagensNaFila: messageQueues.get(userId)?.length || 0,
      conectado: session.ready ? true : false
    });
  }

  res.json(users);
});

app.get('/instance/info/:userId', (req, res) => {
  const { userId } = req.params;
  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;

  res.json({
    userId: session.userId,
    instanceId: session.instanceId,
    ready: session.ready,
    webhookUrl: session.webhookUrl,
    createdAt: session.createdAt,
    number: session.number || null,
    mensagensNaFila: messageQueues.get(userId)?.length || 0
  });
});

app.post('/instance/disconnect/:userId', async (req, res) => {
  const { userId } = req.params;
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
  } catch (err) {
    res.status(500).send('Erro ao desconectar.');
  }
});

app.post('/webhook/set/:userId', (req, res) => {
  const { userId } = req.params;
  const { url } = req.body;
  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;
  
  (async () => {
    try {
      const testePayload = {
        test: true,
        userId,
        instanceId: session.instanceId,
        messageId: generateUniqueId(),
        message: "Teste de validação do webhook"
      };

      const response = await axios.post(url, testePayload, { timeout: 5000 });

      if (response.status >= 200 && response.status < 300) {
        session.webhookUrl = url;
        res.json({
          message: `✅ Webhook válido e setado para ${url}`,
          userId,
          instanceId: session.instanceId,
          webhookUrl: url
        });
      } else {
        res.status(400).send(`⚠️ Webhook respondeu com status ${response.status}. Não foi salvo.`);
      }
    } catch (err) {
      console.error(`Erro ao validar webhook de ${userId}:`, err.message);
      res.status(400).send(`❌ Não foi possível validar o webhook. Erro: ${err.message}`);
    }
  })();
});

app.get('/webhook/get/:userId', (req, res) => {
  const { userId } = req.params;
  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;
  
  res.json({
    userId,
    instanceId: session.instanceId,
    webhookUrl: session.webhookUrl || null
  });
});

app.get('/webhook/list', (req, res) => {
  const result = [];

  activeClients.forEach((session, userId) => {
    if (session.webhookUrl) {
      result.push({ 
        userId, 
        instanceId: session.instanceId,
        webhookUrl: session.webhookUrl 
      });
    }
  });

  res.json(result);
});

function calcularTempoDigitacao(texto) {
  const caracteresPorSegundo = 16;
  const tempo = Math.ceil(texto.length / caracteresPorSegundo) * 1000;
  return Math.min(tempo, 15000);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processQueue(userId) {
  if (isSendingMessage.get(userId)) return;

  const session = activeClients.get(userId);
  if (!session || !session.ready) return;

  const queue = messageQueues.get(userId);
  if (!queue || queue.length === 0) return;

  isSendingMessage.set(userId, true);

  while (queue.length > 0) {
    const { number, message, messageId, resolve, reject } = queue.shift();

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

      // ✅ Registra a mensagem enviada
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
    } catch (err) {
      console.error(`[${userId}] Erro ao enviar mensagem para ${number}:`, err);
      reject(new Error(`Falha ao enviar mensagem para ${number}: ${err.message}`));
    }
  }

  isSendingMessage.set(userId, false);
}

app.post('/message/send-text/:userId', async (req, res) => {
  const { userId } = req.params;
  const { number, message } = req.body;

  const session = activeClients.get(userId);
  if (!session || !session.ready) {
    return res.status(400).send('Client não pronto.');
  }

  if (!messageQueues.has(userId)) {
    messageQueues.set(userId, []);
  }

  // ✅ Gera ID único para a mensagem que será enviada
  const messageId = generateUniqueId();

  const sendPromise = new Promise((resolve, reject) => {
    messageQueues.get(userId).push({ number, message, messageId, resolve, reject });
  });

  processQueue(userId);

  try {
    const result = await sendPromise;
    session.apiCalls++;
    res.json({
      ...result,
      userId,
      instanceId: session.instanceId
    });
  } catch (err) {
    console.error('Erro no envio de mensagem:', err);
    res.status(500).json({
      error: 'Erro ao enviar mensagem.',
      userId,
      instanceId: session.instanceId
    });
  }
});

app.post('/ia/pause/:userId', (req, res) => {
  const { userId } = req.params;
  const { number } = req.body;

  if (!number) return res.status(400).send('Número é obrigatório.');
  
  const session = activeClients.get(userId);
  if (session) session.apiCalls++;
  
  if (!pausedNumbers.has(userId)) {
    pausedNumbers.set(userId, new Set());
  }

  pausedNumbers.get(userId).add(number);
  
  res.json({
    message: `Atendimento da IA pausado para ${number} em ${userId}`,
    userId,
    instanceId: session?.instanceId,
    number,
    actionId: generateUniqueId()
  });
});

app.get('/message/media/:userId/:messageId', async (req, res) => {
  const { userId, messageId } = req.params;

  const session = activeClients.get(userId);
  if (!session || !session.ready) {
    if (session) session.apiCalls++;
    return res.status(400).send('Client não pronto ou não existe.');
  }

  session.apiCalls++;

  try {
    const message = await session.client.getMessageById(messageId);

    if (!message.hasMedia) {
      return res.status(400).send('Esta mensagem não contém mídia.');
    }

    const media = await message.downloadMedia();
    const mediaId = generateUniqueId();

    res.json({
      mediaId,
      messageId,
      userId,
      instanceId: session.instanceId,
      mimetype: media.mimetype,
      data: media.data,
      filename: message._data?.filename || null
    });
  } catch (err) {
    console.error(`[${userId}] Erro ao obter mídia:`, err);
    res.status(500).send(`Erro ao obter mídia: ${err.message}`);
  }
});

app.get('/messages/sent/:userId', (req, res) => {
  const { userId } = req.params;
  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;
  
  res.json({ 
    userId, 
    instanceId: session.instanceId,
    sentMessages: session.sentMessages 
  });
});

app.post('/ia/resume/:userId', (req, res) => {
  const { userId } = req.params;
  const { number } = req.body;

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

app.get('/instance/insights', (req, res) => {
  const insights = [];

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
      webhookUrl: session.webhookUrl,
      webhookCalls: session.webhookCalls,
      queueLength: messageQueues.get(userId)?.length || 0,
      totalLogs: session.logs.length
    });
  }

  res.json(insights);
});

app.get('/instance/insights/:userId', (req, res) => {
  const { userId } = req.params;
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
    webhookUrl: session.webhookUrl,
    webhookCalls: session.webhookCalls,
    queueLength: messageQueues.get(userId)?.length || 0,
    totalLogs: session.logs.length
  });
});

// ✅ Nova rota para buscar mensagem por ID
app.get('/message/:messageId', (req, res) => {
  const { messageId } = req.params;
  const messageInfo = messageRegistry.get(messageId);
  
  if (!messageInfo) {
    return res.status(404).json({ error: 'Mensagem não encontrada.' });
  }

  res.json({
    messageId,
    ...messageInfo
  });
});

// ✅ Nova rota para listar todas as mensagens registradas
app.get('/messages/registry', (req, res) => {
  const messages = [];
  
  for (const [messageId, info] of messageRegistry.entries()) {
    messages.push({
      messageId,
      ...info
    });
  }

  res.json({
    total: messages.length,
    messages
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'API WhatsApp ativa 🚀',
    version: '2.0.0',
    features: ['Unique IDs', 'Message Registry', 'Instance Tracking']
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend multi-sessão com IDs únicos rodando na porta ${PORT}`));