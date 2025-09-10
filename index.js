// index.js (arquivo completo ajustado)
const { NewMessage } = require("telegram/events");
const express = require("express");
const cors = require("cors");
const { Api, TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode-terminal");
const util = require("util");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001; // Porta ajustável

// 🔑 Dados do Telegram (https://my.telegram.org/apps)
const apiId = 20637774;
const apiHash = "030aaf9610ff135dd84423742007daf4";

// Armazenar sessões ativas em memória
const sessions = {};
const messages = [];

// Pasta para persistir sessões
const SESSIONS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Tratamento de erros global do Node.js
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Rejeição não tratada em:', promise, 'motivo:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('❌ Exceção não tratada:', error);
  process.exit(1);
});

// Função para salvar arquivos localmente (com extensão correta)
async function salvarArquivo(buffer, nomeArquivo, mimetype, pastaBase) {
  try {
    const pastaTipo = mimetype ? mimetype.split("/")[0] : "outros";
    const dir = path.join(__dirname, pastaBase, pastaTipo);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, nomeArquivo);
    fs.writeFileSync(filePath, buffer);
    console.log(`💾 Arquivo salvo em: ${filePath}`);
    return filePath;
  } catch (err) {
    console.error("Erro ao salvar arquivo:", err);
    return null;
  }
}

// Função para enviar dados a um Webhook com retry
async function sendWebhook(url, payload, retries = 3) {
  if (!url) {
    console.log("⚠️ sendWebhook chamado sem URL. Ignorando.");
    return;
  }
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`🔄 Tentativa ${i + 1} para webhook: ${url}`);
      await axios.post(url, payload, {
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        timeout: 15000,
      });
      console.log(`✅ Webhook enviado para: ${url}`);
      return;
    } catch (err) {
      console.error(`❌ Erro na tentativa ${i + 1}:`, err.message);
      if (i < retries - 1) await new Promise(resolve => setTimeout(resolve, 2000));
      else console.error(`❌ Todas as tentativas falharam para: ${url}`);
    }
  }
}

// --- helpers para login token / token bytes ---
const toBase64Url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function tokenToBuffer(tokenObj) {
  if (!tokenObj) return null;
  if (Buffer.isBuffer(tokenObj)) return tokenObj;
  if (typeof tokenObj.getBytes === "function") return tokenObj.getBytes();
  if (tokenObj.bytes && Buffer.isBuffer(tokenObj.bytes)) return tokenObj.bytes;
  if (tokenObj.data && Buffer.isBuffer(tokenObj.data)) return tokenObj.data;
  if (Array.isArray(tokenObj)) return Buffer.from(tokenObj);
  return null;
}

// tenta exportLoginToken adaptando camelCase/snake_case por fallback
async function tryExportLoginToken(client) {
  try {
    const resp = await client.invoke(
      new Api.auth.ExportLoginToken({
        apiId: apiId,
        apiHash: apiHash,
        exceptIds: [],
      })
    );
    return resp;
  } catch (err1) {
    try {
      console.log("🔁 Fallback exportLoginToken: tentando snake_case...");
      const resp2 = await client.invoke(
        new Api.auth.ExportLoginToken({
          api_id: apiId,
          api_hash: apiHash,
          except_ids: [],
        })
      );
      return resp2;
    } catch (err2) {
      const err = err2 || err1;
      throw err;
    }
  }
}

// Recupera sessão salva em disco se existir
function readSavedSession(nome) {
  const file = path.join(SESSIONS_DIR, `${nome}.session`);
  if (fs.existsSync(file)) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (e) {
      console.error("Erro lendo session file:", e);
    }
  }
  return null;
}
function saveSessionToDisk(nome, stringSession) {
  const file = path.join(SESSIONS_DIR, `${nome}.session`);
  try {
    fs.writeFileSync(file, stringSession, "utf8");
    console.log(`💾 Session persistida em: ${file}`);
  } catch (e) {
    console.error("❌ Falha ao salvar session em disco:", e);
  }
}

// Criar nova instância do Telegram e gerar QR Code
app.post("/nova-instancia", async (req, res) => {
  try {
    const { Nome, Webhook } = req.body;
    if (!Nome || !Webhook) return res.status(400).json({ error: "Nome e Webhook são obrigatórios" });
    if (sessions[Nome]) return res.json({ status: true, mensagem: "Sessão já existente", nome: Nome });

    // tenta carregar session persistida
    const saved = readSavedSession(Nome);
    const stringSession = new StringSession(saved || "");

    const client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
      baseLogger: console,
    });

    // Se existe session salva e válida, preferimos start() para restaurar
    if (saved) {
      console.log(`🔁 Encontrada session salva para "${Nome}", tentando restaurar...`);
      await client.start({
        // sem `qrCode` aqui — esperamos que a session seja válida
      });

      // se chegou aqui sem erro, estamos conectados e autorizados
      const string = client.session.save();
      sessions[Nome] = { client, webhook: Webhook, stringSession: string };
      console.log(`✅ Instância "${Nome}" restaurada a partir da session salva.`);
      // notifica webhook (async)
      sendWebhook(Webhook, {
        acao: "conexao_restaurada",
        nome: Nome,
        status: "conectado",
        stringSession: string,
        data: new Date().toISOString(),
      }).catch(()=>{});
      return res.json({ status: true, nome: Nome, mensagem: "Sessão restaurada a partir do arquivo." });
    }

    // se não há session salva, procede com fluxo QR
    await client.connect();

    let lastExportToken = null;
    let qrRefreshTimer = null;
    let isAuthenticated = false;

    // generate and show QR (and try webhook)
    const generateAndSendQR = async () => {
      if (isAuthenticated || (sessions[Nome] && sessions[Nome].client)) {
        console.log(`✅ Instância "${Nome}" já autenticada — não gerando QR.`);
        return null;
      }

      try {
        const exportResp = await tryExportLoginToken(client);
        if (!exportResp) throw new Error("exportLoginToken retornou vazio");

        const tokenBuf = tokenToBuffer(exportResp.token);
        if (!tokenBuf) throw new Error("Não foi possível extrair bytes do token retornado");

        lastExportToken = tokenBuf;
        const b64url = toBase64Url(tokenBuf);
        const tgUrl = `tg://login?token=${b64url}`;

        // Exibir OBRIGATORIAMENTE no terminal
        console.log("🔵 QR tg://login gerado (base64url):", tgUrl);
        qrcode.generate(tgUrl, { small: true });

        // Tentar enviar para webhook, sem bloquear
        sendWebhook(Webhook, {
          acao: "qr_code_gerado",
          nome: Nome,
          qrUrl: tgUrl,
          expires: exportResp.expires,
          data: new Date().toISOString(),
        }).catch(() => {
          console.log("⚠️ Não foi possível enviar QR para o webhook. Continuando localmente.");
        });

        // schedule refresh pouco antes de expirar
        const nowSec = Math.floor(Date.now() / 1000);
        const expiresAt = exportResp.expires || (nowSec + 30);
        const msUntilRefresh = Math.max((expiresAt - nowSec - 3) * 1000, 5 * 1000);
        if (qrRefreshTimer) clearTimeout(qrRefreshTimer);
        qrRefreshTimer = setTimeout(() => {
          if (!isAuthenticated && !(sessions[Nome] && sessions[Nome].client)) {
            generateAndSendQR().catch(err => console.error("Erro reexport QR:", err));
          } else {
            console.log(`✅ Instância "${Nome}" autenticada antes do refresh — cancelando regen do QR.`);
          }
        }, msUntilRefresh);

        return { tgUrl, expires: exportResp.expires };
      } catch (err) {
        console.error("❌ erro em generateAndSendQR:", err && err.message ? err.message : err);
        sendWebhook(Webhook, {
          acao: "erro_export_login_token",
          nome: Nome,
          erro: err && err.message ? err.message : String(err),
          data: new Date().toISOString(),
        }).catch(()=>{});
        return null;
      }
    };

    // handler robusto: loga update cru e detecta login token updates
    const updateHandler = async (update) => {
      try {
        console.log("🔔 Update bruto recebido:", util.inspect(update, { depth: 6, colors: false }));

        const looksLikeLoginUpdate = (u) => {
          if (!u) return false;
          if (u._ && typeof u._ === 'string' && u._.toLowerCase().includes('logintoken')) return true;
          if (u.loginToken || u.login_token) return true;
          if (u.update && u.update._ && typeof u.update._ === 'string' && u.update._.toLowerCase().includes('logintoken')) return true;
          if (u.updates && Array.isArray(u.updates)) {
            return u.updates.some(it => it && it._ && typeof it._ === 'string' && it._.toLowerCase().includes('logintoken'));
          }
          if (u.short && u.short._ && typeof u.short._ === 'string' && u.short._.toLowerCase().includes('logintoken')) return true;
          return false;
        };

        if (!looksLikeLoginUpdate(update)) return;

        console.log("🔎 Detected potential login-token update. Attempting confirmation...");

        let confirm;
        try {
          confirm = await tryExportLoginToken(client);
          console.log(">>> confirm (exportLoginToken) response:", util.inspect(confirm, { depth: 6 }));
        } catch (err) {
          console.error("❌ erro ao re-confirmar exportLoginToken:", err && err.message ? err.message : err);
          sendWebhook(Webhook, { acao: "erro_confirm_export", nome: Nome, erro: err.message || String(err) }).catch(()=>{});
          return;
        }

        if (confirm && confirm._ === "auth.loginTokenSuccess") {
          console.log("✅ loginTokenSuccess recebido — sessão autorizada!");
          isAuthenticated = true;
          const string = client.session.save();
          sessions[Nome] = { client, webhook: Webhook, stringSession: string };
          saveSessionToDisk(Nome, string);

          if (qrRefreshTimer) { clearTimeout(qrRefreshTimer); qrRefreshTimer = null; }

          sendWebhook(Webhook, {
            acao: "conexao_estabelecida",
            nome: Nome,
            status: "conectado",
            stringSession: string,
            data: new Date().toISOString(),
          }).catch(()=>{ console.log("⚠️ Não foi possível notificar webhook da conexão."); });

          console.log(`🚀 Instância "${Nome}" pronta. Você pode usar /send-message agora.`);
          try { client.removeEventHandler(updateHandler); } catch(e){}

        } else if (confirm && confirm._ === "auth.loginTokenMigrateTo") {
          console.log("➡️ loginTokenMigrateTo recebido — migrando DC...", confirm);
          try {
            const importResp = await client.invoke(new Api.auth.ImportLoginToken({ token: confirm.token }));
            console.log(">>> importResp:", util.inspect(importResp, { depth: 6 }));

            if (importResp && importResp._ === "auth.loginTokenSuccess") {
              console.log("✅ importLoginToken -> loginTokenSuccess — sessão autorizada!");
              isAuthenticated = true;
              const string = client.session.save();
              sessions[Nome] = { client, webhook: Webhook, stringSession: string };
              saveSessionToDisk(Nome, string);
              if (qrRefreshTimer) { clearTimeout(qrRefreshTimer); qrRefreshTimer = null; }

              sendWebhook(Webhook, {
                acao: "conexao_estabelecida",
                nome: Nome,
                status: "conectado",
                stringSession: string,
                data: new Date().toISOString(),
              }).catch(()=>{});

              console.log(`🚀 Instância "${Nome}" pronta (import). Você pode usar /send-message agora.`);
              try { client.removeEventHandler(updateHandler); } catch(e){}
            } else {
              console.log("⚠️ importLoginToken retornou:", importResp);
              sendWebhook(Webhook, { acao: "erro_import_login_token", nome: Nome, detalhe: importResp }).catch(()=>{});
            }
          } catch (err) {
            console.error("❌ erro ao chamar importLoginToken:", err);
            sendWebhook(Webhook, { acao: "erro_import_login_token", nome: Nome, erro: err.message }).catch(()=>{});
          }
        } else {
          console.log("ℹ️ resposta inesperada ao confirmar token:", util.inspect(confirm, { depth: 6 }));
          sendWebhook(Webhook, { acao: "resposta_inesperada_confirmar_token", nome: Nome, resposta: confirm }).catch(()=>{});
        }
      } catch (err) {
        console.error("❌ erro no updateHandler:", err);
      }
    };

    client.addEventHandler(updateHandler);

    // gera o primeiro QR
    await generateAndSendQR();

    res.json({
      status: true,
      nome: Nome,
      mensagem: "QR Code gerado — exibido no terminal e tentativa enviada ao webhook.",
    });

  } catch (err) {
    console.error("❌ Erro ao criar instância (nova-instancia):", err);
    if (req.body?.Webhook) {
      sendWebhook(req.body.Webhook, {
        acao: "erro_instancia",
        nome: req.body.Nome || "desconhecido",
        erro: err.message,
        data: new Date().toISOString(),
      }).catch(() => {});
    }
    res.status(500).json({ error: "Falha ao criar instância", detalhes: err.message });
  }
});

// Enviar mensagem ou mídia via Telegram
app.post("/send-message", async (req, res) => {
  try {
    const { nome, number, message, midia } = req.body;
    const session = sessions[nome];
    if (!session) return res.status(400).json({ error: "Sessão não encontrada" });

    if (midia) {
      // Envio de arquivo
      const buffer = Buffer.from(midia.base64, "base64");
      const mimetype = midia.mimetype || "application/octet-stream";
      let mediaType = mimetype.split("/")[0] || "outros";
      let extension = (mimetype.split("/")[1] || "bin").split(";")[0];
      let nomeArquivo = `file_${Date.now()}.${extension}`;

      // Salva em "enviados"
      const filePath = await salvarArquivo(buffer, nomeArquivo, mimetype, "enviados");

      // Envia para o Telegram
      await session.client.sendFile(number, {
        file: buffer,
        caption: message || "",
      });

      // Webhook com base64 também
      sendWebhook(session.webhook, {
        acao: "midia_enviada",
        para: number,
        mimetype,
        arquivo: nomeArquivo,
        caminho: filePath,
        base64: midia.base64,
        instancia: nome,
        data: new Date().toISOString(),
      }).catch(() => {});

      res.json({ status: true, msg: "Mídia enviada com sucesso" });
    } else {
      // Apenas texto
      await session.client.sendMessage(number, { message });

      sendWebhook(session.webhook, {
        acao: "mensagem_enviada",
        para: number,
        mensagem: message,
        instancia: nome,
        data: new Date().toISOString(),
      }).catch(() => {});

      res.json({ status: true, msg: "Mensagem enviada com sucesso" });
    }
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// Listar todas as mensagens recebidas (armazenadas em memória)
app.get("/received-messages", async (req, res) => {
  res.json({ total: messages.length, mensagens: messages });
});

// Verificar status de uma instância do Telegram
app.get("/status/:nome", async (req, res) => {
  try {
    const { nome } = req.params;
    const session = sessions[nome];
    if (!session) return res.status(404).json({ error: "Sessão não encontrada" });

    const isConnected = !!session.client && session.client.connected;

    res.json({
      nome,
      conectado: isConnected,
      webhook: session.webhook,
    });
  } catch (err) {
    console.error("❌ Erro ao verificar status:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// Desconectar instância do Telegram
app.delete("/instancia/:nome", async (req, res) => {
  try {
    const { nome } = req.params;
    const session = sessions[nome];
    if (!session) return res.status(404).json({ error: "Sessão não encontrada" });

    await session.client.disconnect();
    delete sessions[nome];

    sendWebhook(session.webhook, {
      acao: "desconectado",
      nome,
      data: new Date().toISOString(),
    }).catch(() => {});

    res.json({ status: true, mensagem: "Instância desconectada com sucesso" });
  } catch (err) {
    console.error("❌ Erro ao desconectar:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// Middleware de erro global do Express
app.use((err, req, res, next) => {
  console.error('❌ Erro não tratado:', err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// Iniciar servidor Express
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
