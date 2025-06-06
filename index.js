const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const cors = require('cors');
const qrcode = require('qrcode');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const activeClients = new Map(); // userId → { client, qr, ready, webhookUrl }
const pausedNumbers = new Map(); // userId => Set de números pausados
const messageQueues = new Map(); // userId => array de mensagens { number, message }
const isSendingMessage = new Map(); // userId => booleano de controle de envio


app.get('/instance/create/:userId', (req, res) => {
  const { userId } = req.params;
  

  if (activeClients.has(userId)) {
    return res.status(400).send('Já existe uma sessão para este usuário.');
  }

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
    logs: [],
    createdAt: new Date(), // ✅ Aqui adiciona a data de criação
    sentMessages: 0,
    receivedMessages: 0,      // ✅ NOVO: Contador de mensagens recebidas
    webhookCalls: 0,          // ✅ NOVO: Total de chamadas feitas ao webhook
    apiCalls: 0               // ✅ NOVO: Total de chamadas na API dessa instância
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
    sessionData.number = client.info.wid.user;  // ← Aqui pega o número da conta
    console.log(`[${userId}] Pronto - Número conectado: ${sessionData.number}`);
    console.log(`[${userId}] Pronto`); 
  });

  client.on('authenticated', () => {
    console.log(`[${userId}] Autenticado`);
  });

  client.on('message', async (msg) => {
    sessionData.receivedMessages++;
    
    const contact = await msg.getContact();
   
    const log = {
      number: msg.from,
      name: contact.pushname || contact.name || contact.number,
      body: msg.body,
      type: msg.type,
      timestamp: new Date(),
      media: null
    };

  if (msg.hasMedia && msg.type === 'ptt') {
    try{
    const media = await msg.downloadMedia();
    if (media) {
      log.media = {
        mimetype: media.mimetype,
        data: media.data,
        filename: `audio-${Date.now()}.ogg`
      };
    }
    } catch (err){
      console.error(`Erro ao baixar mídia: ${err.message}`)
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

  res.status(200).send(`Instância '${userId}' criada com sucesso.`);
});

app.get('/messages/log/:userId', (req, res) => {
  const session = activeClients.get(req.params.userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++; // ✅ Aqui
  res.send(session.logs);
    
});

app.get('/instance/chats/:userId', async (req, res) => {
  const { userId } = req.params;
  const session = activeClients.get(userId);

  if (!session || !session.ready) {
    session.apiCalls++;  // ✅ Aqui
    return res.status(400).send('Instância não pronta ou não existe.');
    
  }

  try {
    const chats = await session.client.getChats();
    const total = chats.length;

    // Se quiser retornar apenas nomes:
    const nomes = chats.map(chat => ({
      id: chat.id._serialized,
      name: chat.name || chat.formattedTitle || chat.id.user
    }));

    res.json({ total, chats: nomes });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao buscar chats.');
  }
});

app.get('/instance/status/:userId', (req, res) => {
  const { userId } = req.params;
  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;  // ✅ Aqui
  res.send(session.ready ? 'Client is ready.' : 'Client not initialized.');
  

});

app.get('/instance/qr/:userId', (req, res) => {
  const { userId } = req.params;
  const session = activeClients.get(userId);
  if (!session || !session.qrCode) return res.status(404).send('QR Code não disponível.');
  session.apiCalls++;  // ✅ Aqui
  res.send(`<img src="${session.qrCode}" />`);
  

});

app.get('/instance/active', (req, res) => {
  const users = [];

  for (const [userId, session] of activeClients.entries()) {
    users.push({
      userId,
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
  session.apiCalls++;  // ✅ Aqui

  res.json({
    userId: session.userId,
    ready: session.ready,
    webhookUrl: session.webhookUrl,
    createdAt: session.createdAt, // ✅ Aqui também
    number: session.number || null,   // ✅ Aqui adiciona o número
    mensagensNaFila: messageQueues.get(userId)?.length || 0
  });
});

app.post('/instance/disconnect/:userId', async (req, res) => {
  const { userId } = req.params;
  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;  // ✅ Aqui

  try {
    await session.client.logout();
    await session.client.destroy();
    activeClients.delete(userId);

    res.send(`Sessão ${userId} desconectada.`);
  } catch (err) {
    res.status(500).send('Erro ao desconectar.');
  }
});

app.post('/webhook/set/:userId', (req, res) => {
  const { userId } = req.params;
  const { url } = req.body;
  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  session.apiCalls++;  // ✅ Aqui
  (async () => {
  try {
    // Validação: envia um teste simples para o webhook
    const testePayload = {
      test: true,
      userId,
      message: "Teste de validação do webhook"
    };

    const response = await axios.post(url, testePayload, { timeout: 5000 });

    if (response.status >= 200 && response.status < 300) {
      session.webhookUrl = url;
      res.send(`✅ Webhook válido e setado para ${url}`);
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
  session.apiCalls++;  // ✅ Aqui
  res.send(session.webhookUrl || 'Nenhum webhook configurado.');
  
});

app.get('/webhook/list', (req, res) => {
  const result = [];

  activeClients.forEach((session, userId) => {
    if (session.webhookUrl) {
      result.push({ userId, webhookUrl: session.webhookUrl });
    }
  });

  res.send(result);
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
  if (isSendingMessage.get(userId)) return; // já está processando

  const session = activeClients.get(userId);
  if (!session || !session.ready) return;

  const queue = messageQueues.get(userId);
  if (!queue || queue.length === 0) return;

  isSendingMessage.set(userId, true);

  while (queue.length > 0) {
    const { number, message, resolve, reject } = queue.shift();

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
      await session.client.sendMessage(chatId, message);
      session.sentMessages += 1;

      resolve('Mensagem enviada!');
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

  // Retornamos a promessa de envio para dar resposta correta à API
  const sendPromise = new Promise((resolve, reject) => {
    messageQueues.get(userId).push({ number, message, resolve, reject });
  });

  processQueue(userId); // inicia o processamento da fila

  try {
    const result = await sendPromise;
    session.apiCalls++;  // ✅ Aqui
    res.send(result);
    
 } catch (err) {
  console.error('Erro no envio de mensagem:', err); // 👈 Log completo
  res.status(500).send('Erro ao enviar mensagem.');
}
});

app.post('/ia/pause/:userId', (req, res) => {
  const { userId } = req.params;
  const { number } = req.body;

  if (!number) return res.status(400).send('Número é obrigatório.');
  session.apiCalls++;  // ✅ Aqui
  if (!pausedNumbers.has(userId)) {
    pausedNumbers.set(userId, new Set());
  }

  pausedNumbers.get(userId).add(number);
  res.send(`Atendimento da IA pausado para ${number} em ${userId}`);
});


app.get('/message/media/:userId/:messageId', async (req, res) => {
  const { userId, messageId } = req.params;

  const session = activeClients.get(userId);
  if (!session || !session.ready) {
    session.apiCalls++;  // ✅ Aqui
    return res.status(400).send('Client não pronto ou não existe.');
    
  }

  try {
    const message = await session.client.getMessageById(messageId);

    if (!message.hasMedia) {
      return res.status(400).send('Esta mensagem não contém mídia.');
    }

    const media = await message.downloadMedia();

    res.json({
      mimetype: media.mimetype,
      data: media.data,  // base64 puro
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
  session.apiCalls++;  // ✅ Aqui
  res.json({ userId, sentMessages: session.sentMessages });
  
});


// Retomar IA para um número específico
app.post('/ia/resume/:userId', (req, res) => {
  const { userId } = req.params;
  const { number } = req.body;

  if (!number) return res.status(400).send('Número é obrigatório.');

  const userPaused = pausedNumbers.get(userId);
  if (userPaused) {
    session.apiCalls++;  // ✅ Aqui  
    userPaused.delete(number);
  }

  res.send(`Atendimento da IA retomado para ${number} em ${userId}`);
  
});

app.get('/instance/insights', (req, res) => {
  const insights = [];

  for (const [userId, session] of activeClients.entries()) {
    insights.push({
      userId,
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

  session.apiCalls++;  // ✅ contabiliza também essa chamada

  res.json({
    userId: session.userId,
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

app.get('/', (req, res) => {
  res.send('API WhatsApp ativa 🚀');
});


const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend multi-sessão rodando na porta ${PORT}`));
