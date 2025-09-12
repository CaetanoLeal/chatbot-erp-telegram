const { NewMessage } = require("telegram/events");
const express = require("express");
const cors = require("cors");
const { Api, TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode-terminal");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Credenciais Telegram
const apiId = 20637774;
const apiHash = "030aaf9610ff135dd84423742007daf4";

// Pasta para persistir sessões
const SESSIONS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Sessões em memória
const sessions = {};
const messages = [];

/* -------------------- Funções Utilitárias -------------------- */

async function sendWebhook(url, payload) {
  if (!url) return;
  try {
    await axios.post(url, payload, { headers: { "Content-Type": "application/json" }, timeout: 10000 });
    console.log("✅ Webhook enviado:", payload.acao);
  } catch (err) {
    console.error("❌ Erro ao enviar webhook:", err.message);
  }
}

function saveSession(nome, stringSession) {
  const file = path.join(SESSIONS_DIR, `${nome}.session`);
  fs.writeFileSync(file, stringSession, "utf8");
  console.log("💾 StringSession salva:", file);
}

function readSession(nome) {
  const file = path.join(SESSIONS_DIR, `${nome}.session`);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  return null;
}

/* -------------------- Endpoints -------------------- */

// Criar nova instância via client.start (login por telefone)
app.post("/nova-instancia", async (req, res) => {
  try {
    const { Nome, Webhook, phoneNumber } = req.body;
    if (!Nome || !Webhook || !phoneNumber)
      return res.status(400).json({ error: "Nome, Webhook e phoneNumber são obrigatórios" });

    if (sessions[Nome]) return res.json({ status: true, mensagem: "Sessão já existente" });

    const savedSession = readSession(Nome);
    const stringSession = new StringSession(savedSession || "");
    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

    const messageHandler = async (event) => {
      const msg = event.message;
      const texto = msg?.message ?? "";
      messages.push({ remetente: String(msg.senderId ?? ""), texto, data: new Date().toISOString() });
      sendWebhook(Webhook, {
        acao: "mensagem_recebida",
        de: msg.senderId?.toString(),
        texto,
        instancia: Nome,
        data: new Date().toISOString(),
      });
    };
    client.addEventHandler(messageHandler, new NewMessage({}));

    await client.start({
      phoneNumber: async () => phoneNumber,
      phoneCode: async () => await input.text("Digite o código recebido no Telegram: "),
      password: async () => await input.text("Digite a senha 2FA (se houver): "),
      onError: (err) => console.log("❌ Erro no start:", err),
    });

    const string = client.session.save();
    saveSession(Nome, string);

    sessions[Nome] = { client, webhook: Webhook, stringSession: string, isConfirmed: true };

    console.log(`✅ Sessão iniciada: ${Nome}`);
    sendWebhook(Webhook, {
      acao: "sessao_iniciada",
      nome: Nome,
      status: "conectado",
      data: new Date().toISOString(),
    });

    res.json({ status: true, nome: Nome, mensagem: "Sessão iniciada com sucesso" });
  } catch (err) {
    console.error("❌ Erro ao criar instância:", err);
    res.status(500).json({ error: err.message });
  }
});

// Criar QR code separado
app.post("/qrcode", async (req, res) => {
  try {
    const { Nome, Webhook } = req.body;
    if (!Nome || !Webhook) return res.status(400).json({ error: "Nome e Webhook são obrigatórios" });

    if (sessions[Nome]) return res.json({ status: true, mensagem: "Sessão já existente" });

    const stringSession = new StringSession("");
    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    await client.connect();

    const exportResp = await client.invoke(new Api.auth.ExportLoginToken({ apiId, apiHash, exceptIds: [] }));
    const b64url = Buffer.from(exportResp.token)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const tgUrl = `tg://login?token=${b64url}`;
    qrcode.generate(tgUrl, { small: true });

    sessions[Nome] = { client, webhook: Webhook, stringSession: "", isConfirmed: false };

    sendWebhook(Webhook, {
      acao: "qr_code_gerado",
      nome: Nome,
      qrUrl: tgUrl,
      data: new Date().toISOString(),
    });

    res.json({ status: true, nome: Nome, mensagem: "QR Code gerado — exibido no terminal" });
  } catch (err) {
    console.error("❌ Erro ao gerar QR code:", err);
    res.status(500).json({ error: err.message });
  }
});

// Enviar mensagem
app.post("/send-message", async (req, res) => {
  try {
    const { nome, number, message } = req.body;
    const session = sessions[nome];
    if (!session) return res.status(400).json({ error: "Sessão não encontrada" });
    if (!session.isConfirmed) return res.status(400).json({ error: "Sessão não confirmada" });

    await session.client.sendMessage(number, { message });

    sendWebhook(session.webhook, {
      acao: "mensagem_enviada",
      para: number,
      mensagem: message,
      instancia: nome,
      data: new Date().toISOString(),
    });

    res.json({ status: true, msg: "Mensagem enviada com sucesso" });
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem:", err);
    res.status(500).json({ error: err.message });
  }
});

// Listar mensagens recebidas
app.get("/received-messages", (req, res) => {
  res.json({ total: messages.length, mensagens: messages });
});

// Status da instância
app.get("/status/:nome", (req, res) => {
  try {
    const { nome } = req.params;
    const session = sessions[nome];
    if (!session) return res.status(404).json({ error: "Sessão não encontrada" });

    res.json({
      nome,
      conectado: !!session.client && session.client.connected,
      webhook: session.webhook,
      isConfirmed: session.isConfirmed,
    });
  } catch (err) {
    console.error("❌ Erro ao verificar status:", err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- Iniciar servidor -------------------- */
app.listen(PORT, () => console.log(`🚀 Servidor rodando em http://localhost:${PORT}`));
