const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');
const qrcode = require('qrcode-terminal');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const activeClients = new Map();
const LOGS_DIR = path.join(__dirname, 'logs');
fs.ensureDirSync(LOGS_DIR);

function getLogFilePath(userId) {
  return path.join(LOGS_DIR, `${userId}.json`);
}

async function loadLogs(userId) {
  const filePath = getLogFilePath(userId);
  if (await fs.pathExists(filePath)) {
    return await fs.readJSON(filePath);
  }
  return [];
}

async function saveLogs(userId, logs) {
  const filePath = getLogFilePath(userId);
  await fs.writeJSON(filePath, logs);
}

app.post('/start', async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).send('Parâmetro userId é obrigatório.');
  }

  if (activeClients.has(userId)) {
    return res.status(400).send('Cliente já está ativo.');
  }

  const sessionId = uuidv4();
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
    puppeteer: {
      args: ['--no-sandbox'],
    },
  });

  activeClients.set(userId, { client, qr: null, status: 'starting', logs: [] });

  client.on('qr', (qr) => {
    console.log(`QR code para ${userId}:`, qr);
    qrcode.generate(qr, { small: true });
    activeClients.get(userId).qr = qr;
    activeClients.get(userId).status = 'qrcode';
  });

  client.on('ready', () => {
    console.log(`Cliente ${userId} está pronto.`);
    activeClients.get(userId).status = 'ready';
  });

  client.on('authenticated', () => {
    console.log(`Cliente ${userId} autenticado.`);
    activeClients.get(userId).status = 'authenticated';
  });

  client.on('auth_failure', () => {
    console.log(`Falha de autenticação para ${userId}.`);
    activeClients.get(userId).status = 'auth_failure';
  });

  client.on('disconnected', (reason) => {
    console.log(`Cliente ${userId} desconectado:`, reason);
    activeClients.delete(userId);
  });

  client.on('message', async (message) => {
    const log = {
      from: message.from,
      body: message.body,
      timestamp: new Date().toISOString(),
    };

    const sessionData = activeClients.get(userId);
    if (sessionData) {
      sessionData.logs.push(log);
      await saveLogs(userId, sessionData.logs);
    }
  });

  client.initialize();
  res.send(`Inicializando cliente para ${userId}.`);
});

app.get('/qr/:userId', (req, res) => {
  const session = activeClients.get(req.params.userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  res.send(session.qr || 'QR code ainda não gerado.');
});

app.get('/status/:userId', (req, res) => {
  const session = activeClients.get(req.params.userId);
  if (!session) return res.status(404).send('Sessão não encontrada.');
  res.send(session.status);
});

app.get('/messages/log/:userId', async (req, res) => {
  const { userId } = req.params;
  const session = activeClients.get(userId);

  if (session) {
    return res.send(session.logs);
  }

  try {
    const logs = await loadLogs(userId);
    if (logs.length === 0) {
      return res.status(404).send('Sem logs disponíveis.');
    }
    res.send(logs);
  } catch (err) {
    console.error(`Erro ao carregar logs de ${userId}:`, err.message);
    res.status(500).send('Erro ao carregar logs.');
  }
});

app.post('/send', async (req, res) => {
  const { userId, to, message } = req.body;

  if (!activeClients.has(userId)) {
    return res.status(400).send('Cliente não está ativo.');
  }

  const { client } = activeClients.get(userId);

  try {
    const number = to.replace('@c.us', ''); // remove @c.us se presente
    const numberId = await client.getNumberId(number);

    if (!numberId) {
      return res.status(404).send('Número não encontrado no WhatsApp.');
    }

    await client.sendMessage(`${numberId._serialized}`, message);
    res.send('Mensagem enviada.');
  } catch (err) {
    console.error('Erro ao enviar mensagem:', err);
    res.status(500).send('Erro ao enviar mensagem.');
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
