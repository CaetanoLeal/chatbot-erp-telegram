const express = require("express");
const app = express();

app.use(express.json()); // para ler JSON

// Rota que recebe os POSTs
app.post("/webhook", (req, res) => {
  console.log("📩 Webhook recebido:");
  console.log(JSON.stringify(req.body, null, 2));

  // responde com sucesso
  res.json({ status: true, recebido: req.body });
});

// Inicia na porta 4000 (pode ser qualquer)
const PORT = 4000;
app.listen(PORT, () => {
  console.log(`✅ Webhook de teste rodando em http://localhost:${PORT}/webhook`);
});
