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
    logs: [] 
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
    console.log(`[${userId}] Pronto`); 
  });

  client.on('authenticated', () => {
    console.log(`[${userId}] Autenticado`);
  });

  client.on('message', async (msg) => {
    const contact = await msg.getContact();
  
    const log = {
      number: msg.from,
      name: contact.pushname || contact.name || contact.number,
      body: msg.body,
      type: msg.type,
      timestamp: new Date()
    };
  
    sessionData.logs.push(log);
  
   const isPaused = pausedNumbers.get(userId)?.has(msg.from);

    if (isPaused) {
      console.log(`[IA PAUSADA] Mensagem de ${msg.from} ignorada pela IA.`);
    } else if (sessionData.webhookUrl) {
      try {
        await axios.post(sessionData.webhookUrl, { ...log, userId });
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
  res.send(session.logs);
});

app.get('/instance/chats/:userId', async (req, res) => {
  const { userId } = req.params;
  const session = activeClients.get(userId);

  if (!session || !session.ready) {
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
  res.send(session.ready ? 'Client is ready.' : 'Client not initialized.');
});

app.get('/instance/qr/:userId', (req, res) => {
  const { userId } = req.params;
  const session = activeClients.get(userId);
  if (!session || !session.qrCode) return res.status(404).send('QR Code não disponível.');
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

app.post('/instance/disconnect/:userId', async (req, res) => {
  const { userId } = req.params;
  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');

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
  session.webhookUrl = url;
  res.send(`Webhook para ${userId} setado para ${url}`);
});

app.get('/webhook/get/:userId', (req, res) => {
  const { userId } = req.params;
  const session = activeClients.get(userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
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

app.post('/message/send-text/:userId', async (req, res) => {
  const { userId } = req.params;
  const { number, message } = req.body;

  const session = activeClients.get(userId);
  if (!session || !session.ready) return res.status(400).send('Client não pronto.');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function calcularTempoDigitacao(texto) {
  const caracteresPorSegundo = 16; // Altere se quiser mais rápido ou mais lento
  const tempo = Math.ceil(texto.length / caracteresPorSegundo) * 1000;
  return Math.min(tempo, 15000); // Limita a 15 segundos de digitação
}

try {
  const chatId = `${number}@c.us`;
  const chat = await session.client.getChatById(chatId);

  const tempoDigitacao = calcularTempoDigitacao(message);

  await chat.sendStateTyping(); // Simula digitação
  await delay(tempoDigitacao); // Espera proporcional ao texto
  await chat.clearState(); // Para de digitar

  await session.client.sendMessage(chatId, message);

  res.send('Mensagem enviada com simulação de digitação!');
} catch (err) {
  console.error(err);
  res.status(500).send('Erro ao enviar.');
}
});

app.post('/ia/pause/:userId', (req, res) => {
  const { userId } = req.params;
  const { number } = req.body;

  if (!number) return res.status(400).send('Número é obrigatório.');

  if (!pausedNumbers.has(userId)) {
    pausedNumbers.set(userId, new Set());
  }

  pausedNumbers.get(userId).add(number);
  res.send(`Atendimento da IA pausado para ${number} em ${userId}`);
});

// Retomar IA para um número específico
app.post('/ia/resume/:userId', (req, res) => {
  const { userId } = req.params;
  const { number } = req.body;

  if (!number) return res.status(400).send('Número é obrigatório.');

  const userPaused = pausedNumbers.get(userId);
  if (userPaused) {
    userPaused.delete(number);
  }

  res.send(`Atendimento da IA retomado para ${number} em ${userId}`);
});

app.get('/', (req, res) => {
  res.send('API WhatsApp ativa 🚀');
});


const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend multi-sessão rodando na porta ${PORT}`));
