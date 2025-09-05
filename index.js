const { NewMessage } = require("telegram/events");
const express = require("express");
const cors = require("cors");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram/tl");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const qrcode = require("qrcode-terminal");

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

// Função para salvar arquivo em "enviados" ou "recebidos"
async function salvarArquivo(buffer, nomeArquivo, mimetype, pastaBase) {
  try {
    const pastaTipo = mimetype ? mimetype.split("/")[0] : "outros";
    const dir = path.join(__dirname, pastaBase, pastaTipo);

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
    const client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
    });

    // Variável para armazenar o token QR
    let qrCodeToken = null;

    // Iniciar conexão via QR Code
    await client.start({
      qrCode: async (qrCode) => {
        // Exibir QR Code no terminal
        console.log("🔵 QR Code gerado:");
        qrcode.generate(qrCode, { small: true });
        
        // Armazenar o token para enviar ao webhook
        qrCodeToken = qrcode;
        
        // Enviar a string bruta do QR Code para o webhook
        await sendWebhook(Webhook, {
          acao: "qr_code_gerado",
          nome: Nome,
          qrCode: qrCode,
          data: new Date().toISOString()
        });
      },
      onError: (err) => {
        console.error("❌ Erro na conexão:", err);
        sendWebhook(Webhook, {
          acao: "erro_conexao",
          nome: Nome,
          erro: err.message,
          data: new Date().toISOString()
        });
      },
    });

    console.log("✅ Telegram conectado via QR Code!");
    console.log("💾 StringSession:", client.session.save());
    
    sessions[Nome] = { client, webhook: Webhook };

    // Webhook de conexão bem-sucedida
    await sendWebhook(Webhook, {
      acao: "conexao_estabelecida",
      nome: Nome,
      status: "conectado",
      stringSession: client.session.save(),
      data: new Date().toISOString()
    });

    // Evento de mensagens recebidas
    client.addEventHandler(
      async (event) => {
        const message = event.message;
        console.log("📨 Mensagem recebida:", message);

        // 🔹 Envia sempre a mensagem completa para o webhook
        try {
          await sendWebhook(Webhook, {
            acao: "mensagem_recebida",
            nome: Nome,
            data: new Date().toISOString(),
            mensagem: message, // aqui vai o objeto inteiro
          });
        } catch (err) {
          console.error("❌ Erro ao enviar mensagem completa:", err);
        }

        // 🔹 Se ainda quiser tratar mídia separadamente (opcional)
        if (message.media) {
          try {
            const buffer = await client.downloadMedia(message.media, { workers: 1 });

            let mimetype = "application/octet-stream";
            if (message.media.document) {
              mimetype = message.media.document.mimeType || mimetype;
            }

            const base64 = buffer.toString("base64");

            await sendWebhook(Webhook, {
              acao: "midia_recebida",
              nome: Nome,
              remetente: message.senderId?.toString(),
              mimetype,
              base64,
              data: new Date().toISOString(),
            });
          } catch (err) {
            console.error("❌ Erro ao processar mídia:", err);
          }
        }
      },
      new NewMessage({})
    );

    res.json({ 
      status: true, 
      nome: Nome, 
      mensagem: "QR Code gerado e enviado para o webhook",
      qrCodeEnviado: qrCodeToken !== null
    });
  } catch (err) {
    console.error("❌ Erro ao criar instância:", err);
    
    // Enviar erro para o webhook
    if (Webhook) {
      await sendWebhook(Webhook, {
        acao: "erro_instancia",
        nome: Nome,
        erro: err.message,
        data: new Date().toISOString()
      });
    }
    
    res.status(500).json({ 
      error: "Falha ao criar instância",
      detalhes: err.message 
    });
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
        data: new Date().toISOString()
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
        data: new Date().toISOString()
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
 * Verificar status da instância
 */
app.get("/status/:nome", async (req, res) => {
  try {
    const { nome } = req.params;
    const session = sessions[nome];
    
    if (!session) {
      return res.status(404).json({ error: "Sessão não encontrada" });
    }
    
    const isConnected = await session.client.isConnected();
    
    res.json({
      nome: nome,
      conectado: isConnected,
      webhook: session.webhook
    });
  } catch (err) {
    console.error("❌ Erro ao verificar status:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

/**
 * Desconectar instância
 */
app.delete("/instancia/:nome", async (req, res) => {
  try {
    const { nome } = req.params;
    const session = sessions[nome];
    
    if (!session) {
      return res.status(404).json({ error: "Sessão não encontrada" });
    }
    
    await session.client.disconnect();
    delete sessions[nome];
    
    // Enviar webhook de desconexão
    await sendWebhook(session.webhook, {
      acao: "desconectado",
      nome: nome,
      data: new Date().toISOString()
    });
    
    res.json({ status: true, mensagem: "Instância desconectada com sucesso" });
  } catch (err) {
    console.error("❌ Erro ao desconectar:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

/**
 * Iniciar servidor
 */
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});