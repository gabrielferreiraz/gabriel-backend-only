const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const cors = require('cors');
const qrcode = require('qrcode');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const activeClients = new Map(); // userId → { client, qr, ready, webhookUrl }
const messageQueues = new Map(); // userId → [ { number, message } ]

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function calcularTempoDigitacao(texto) {
  const caracteresPorSegundo = 6;
  const tempo = Math.ceil(texto.length / caracteresPorSegundo) * 1000;
  return Math.min(tempo, 15000);
}

async function humanizedSendMessage(client, number, message) {
  const chatId = `${number}@c.us`;
  const chat = await client.getChatById(chatId);

  const tempoDigitacao = calcularTempoDigitacao(message);

  await chat.sendStateTyping();
  await delay(tempoDigitacao);
  await chat.clearState();

  await client.sendMessage(chatId, message);
}

function startMessageDispatcher(userId) {
  const session = activeClients.get(userId);
  if (!session) return;

  const queue = [];
  messageQueues.set(userId, queue);

  const dispatchLoop = async () => {
    if (queue.length > 0 && session.ready) {
      const { number, message } = queue.shift();
      try {
        await humanizedSendMessage(session.client, number, message);
        await delay(5000 + Math.random() * 3000); // 5-8 segundos
      } catch (err) {
        console.error(`Erro ao enviar mensagem para ${number}: ${err.message}`);
      }
    }
    setTimeout(dispatchLoop, 1000);
  };

  dispatchLoop();
}

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
    startMessageDispatcher(userId);
  });

  client.on('authenticated', () => {
    console.log(`[${userId}] Autenticado`);
  });

  client.on('message', async (msg) => {
    const log = {
      number: msg.from,
      body: msg.body,
      type: msg.type,
      timestamp: new Date()
    };
    sessionData.logs.push(log);

    if (sessionData.webhookUrl) {
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

app.post('/message/send-text/:userId', async (req, res) => {
  const { userId } = req.params;
  const { number, mensagens, modoHumano = true, digitarFrasePorFrase = false, simularAudio = false } = req.body;

  const session = activeClients.get(userId);
  if (!session || !session.ready) return res.status(400).send('Client não pronto.');

  try {
    const chatId = `${number}@c.us`;
    const chat = await session.client.getChatById(chatId);

    for (const mensagem of mensagens) {
      if (modoHumano) {
        if (simularAudio) {
          await chat.sendStateRecording(); // Simula áudio sendo gravado
          await delay(2000 + Math.random() * 2000);
          await chat.clearState();
        }

        if (digitarFrasePorFrase) {
          const frases = mensagem.split(/(?<=[.!?])\s+/); // Quebra em frases

          for (const frase of frases) {
            const tempoDigitacao = calcularTempoDigitacao(frase);

            await chat.sendStateTyping();
            await delay(tempoDigitacao);
            await chat.clearState();

            await session.client.sendMessage(chatId, frase);
            await delay(1000 + Math.random() * 2000); // Pausa entre frases
          }
        } else {
          const tempoDigitacao = calcularTempoDigitacao(mensagem);

          await chat.sendStateTyping();
          await delay(tempoDigitacao);
          await chat.clearState();

          await session.client.sendMessage(chatId, mensagem);
          await delay(1000 + Math.random() * 2000); // Pausa entre blocos
        }

      } else {
        await session.client.sendMessage(chatId, mensagem);
      }
    }

    res.send('Mensagens enviadas com humanização!');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao enviar mensagem.');
  }
});

app.get('/', (req, res) => {
  res.send('API WhatsApp ativa 🚀');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend multi-sessão rodando na porta ${PORT}`));
