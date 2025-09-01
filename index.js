const { NewMessage } = require("telegram/events");
const express = require("express");
const cors = require("cors");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input"); // para pedir código de login
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;

// 🔑 Seus dados do Telegram (https://my.telegram.org/apps)
const apiId = 20637774;
const apiHash = "030aaf9610ff135dd84423742007daf4";

// Guardar sessões em memória
const sessions = {};
const messages = [];

// Função para salvar arquivo em "recebidos"
async function salvarArquivo(buffer, nomeArquivo, mimetype) {
  try {
    const pastaTipo = mimetype ? mimetype.split("/")[0] : "outros";
    const dir = path.join(__dirname, "recebidos", pastaTipo);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const filePath = path.join(dir, nomeArquivo);
    fs.writeFileSync(filePath, buffer);

    console.log(`💾 Arquivo salvo em: ${filePath}`);
    return filePath;
  } catch (err) {
    console.error("Erro ao salvar arquivo:", err);
    return null;
  }
}

// Função para enviar dados ao WebHook
async function sendWebhook(url, payload) {
  if (!url) return;

  try {
    await axios.post(url, payload, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      timeout: 10000,
    });

    console.log(`✅ Webhook enviado para: ${url}`);
  } catch (err) {
    console.error("❌ Erro ao enviar para WebHook:", err.message);
  }
}

/**
 * Criar nova instância do Telegram
 */
app.post("/nova-instancia", async (req, res) => {
  try {
    const { Nome, Webhook } = req.body;
    if (!Nome || !Webhook) {
      return res.status(400).json({ error: "Nome e Webhook são obrigatórios" });
    }

    if (sessions[Nome]) {
      return res.json({ status: true, mensagem: "Sessão já existente", nome: Nome });
    }

    const stringSession = new StringSession("");
    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

    // Login inicial
    await client.start({
      phoneNumber: async () => await input.text("📱 Digite seu número do Telegram (+55...): "),
      password: async () => await input.text("🔑 Digite sua senha 2FA (se tiver): "),
      phoneCode: async () => await input.text("📩 Digite o código que recebeu no Telegram: "),
      onError: (err) => console.log(err),
    });

    console.log("✅ Telegram conectado!");
    console.log("💾 StringSession:", client.session.save());

    sessions[Nome] = { client, webhook: Webhook };

    // Webhook de criação
    await sendWebhook(Webhook, {
      acao: "nova_instancia",
      nome: Nome,
      status: "conectado",
      stringSession: client.session.save(),
    });

    // Evento de mensagens recebidas
    client.addEventHandler(
      async (event) => {
        const message = event.message;

        // Só texto → apenas webhook
        if (message.text && !message.media) {
          const msg = {
            de: message.senderId?.toString(),
            texto: message.text,
            data: message.date,
          };

          messages.push(msg);
          console.log("📩 Texto recebido:", msg.texto);

          await sendWebhook(Webhook, {
            acao: "mensagem_recebida",
            mensagem: msg.texto,
            remetente: msg.de,
            mensagem_completa: msg,
          });
        }

        // Se tiver mídia → salva em recebidos e manda base64
        else if (message.media) {
          try {
            const buffer = await client.downloadMedia(message.media, { workers: 1 });
            const mimetype = message.media.document?.mimeType || "application/octet-stream";
            const ext = mime.extension(mimetype) || "bin";
            const nomeArquivo = `file_${Date.now()}.${ext}`;

            const filePath = await salvarArquivo(buffer, nomeArquivo, mimetype);
            const base64 = buffer.toString("base64");

            await sendWebhook(Webhook, {
              acao: "midia_recebida",
              remetente: message.senderId?.toString(),
              mimetype,
              arquivo: nomeArquivo,
              caminho: filePath,
              base64,
              data: message.date,
            });
          } catch (err) {
            console.error("❌ Erro ao processar mídia:", err);
          }
        }
      },
      new NewMessage({})
    );

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
    const { nome, number, message, midia } = req.body;
    const session = sessions[nome];
    if (!session) return res.status(400).json({ error: "Sessão não encontrada" });

    // Se tiver mídia em base64
    if (midia) {
      const buffer = Buffer.from(midia.base64, "base64");
      const mimetype = midia.mimetype || "application/octet-stream";

      await session.client.sendFile(number, {
        file: buffer,
        caption: message || "",
      });

      await sendWebhook(session.webhook, {
        acao: "midia_enviada",
        para: number,
        mimetype,
        base64: midia.base64,
        instancia: nome,
      });

      res.json({ status: true, msg: "Mídia enviada com sucesso" });
    } else {
      // Só texto
      await session.client.sendMessage(number, { message });

      await sendWebhook(session.webhook, {
        acao: "mensagem_enviada",
        para: number,
        mensagem: message,
        instancia: nome,
      });

      res.json({ status: true, msg: "Mensagem enviada com sucesso" });
    }
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

/**
 * Listar mensagens recebidas
 */
app.get("/received-messages", async (req, res) => {
  res.json({ total: messages.length, mensagens: messages });
});

/**
 * Iniciar servidor
 */
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
