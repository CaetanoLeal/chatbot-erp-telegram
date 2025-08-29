const express = require("express");
const cors = require("cors");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input"); // para pedir código de login

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;

// 🔑 Seus dados do Telegram (https://my.telegram.org/apps)
const apiId = 20637774; 
const apiHash = "030aaf9610ff135dd84423742007daf4";

// Guardar sessões em memória (pode depois salvar em arquivo/DB)
const sessions = {};
const messages = [];

/**
 * Criar nova instância do Telegram
 */
app.post("/nova-instancia", async (req, res) => {
  try {
    const { Nome } = req.body;
    if (!Nome) return res.status(400).json({ error: "Nome é obrigatório" });

    // Se já existir, retorna
    if (sessions[Nome]) {
      return res.json({ status: true, mensagem: "Sessão já existente", nome: Nome });
    }

    const stringSession = new StringSession(""); // vazio no começo
    const client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
    });

    // Login inicial
    await client.start({
      phoneNumber: async () => await input.text("📱 Digite seu número do Telegram (+55...): "),
      password: async () => await input.text("🔑 Digite sua senha 2FA (se tiver): "),
      phoneCode: async () => await input.text("📩 Digite o código que recebeu no Telegram: "),
      onError: (err) => console.log(err),
    });

    console.log("✅ Telegram conectado!");
    console.log("💾 StringSession (salve isso para não precisar logar de novo):");
    console.log(client.session.save());

    sessions[Nome] = client;

    // Listener de mensagens recebidas
    client.addEventHandler((event) => {
      if (event.message && event.message.message) {
        console.log("📩 Nova mensagem:", event.message.message);
        messages.push({
          de: event.message.senderId?.toString(),
          texto: event.message.message,
          data: event.message.date,
        });
      }
    }, {});

    res.json({ status: true, nome: Nome, mensagem: "Sessão iniciada com sucesso" });

  } catch (err) {
    console.error("❌ Erro ao criar instância:", err);
    res.status(500).json({ error: "Falha ao criar instância" });
  }
});

/**
 * Enviar mensagem
 */
app.post("/send-message", async (req, res) => {
  try {
    const { nome, number, message } = req.body;
    const client = sessions[nome];
    if (!client) return res.status(400).json({ error: "Sessão não encontrada" });

    await client.sendMessage(number, { message });
    res.json({ status: true, msg: "Mensagem enviada com sucesso" });
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

/**
 * Listar mensagens recebidas
 */
app.get("/received-messages", (req, res) => {
  res.json({ total: messages.length, mensagens: messages });
});

/**
 * Iniciar servidor
 */
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://172.26.80.1:${PORT}`);
});
