const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

// 📂 Pasta onde as mídias já estão salvas
const WEBHOOK_DIR = path.join(__dirname, "webhook");
if (!fs.existsSync(WEBHOOK_DIR)) {
  fs.mkdirSync(WEBHOOK_DIR, { recursive: true });
}

// Função para pegar o último arquivo salvo na pasta
function pegarUltimaMidia() {
  const files = fs.readdirSync(WEBHOOK_DIR)
    .map(file => ({
      arquivo: file,
      ctime: fs.statSync(path.join(WEBHOOK_DIR, file)).ctime
    }))
    .sort((a, b) => b.ctime - a.ctime); // ordena do mais recente para o mais antigo

  return files.length ? files[0] : null;
}

// Endpoint para retornar a última mídia diretamente (como imagem)
app.get("/webhook-midia", (req, res) => {
  const ultima = pegarUltimaMidia();
  if (!ultima) {
    return res.status(404).send("Nenhuma mídia encontrada");
  }

  const filePath = path.join(WEBHOOK_DIR, ultima.arquivo);
  res.sendFile(filePath);
});

// Endpoint para listar todas as mídias
app.get("/imagens", (req, res) => {
  const files = fs.readdirSync(WEBHOOK_DIR);
  const urls = files.map(file => `/webhook/${file}`);
  res.json({ total: files.length, arquivos: urls });
});

// Servir arquivos estáticos
app.use("/webhook", express.static(WEBHOOK_DIR));

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
  console.log(`📄 Última mídia: http://localhost:${PORT}/webhook-midia`);
  console.log(`📷 Listar todas as imagens: http://localhost:${PORT}/imagens`);
});
