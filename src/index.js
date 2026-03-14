require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const auth = require("./middleware/auth.js");
const blingProxy = require("./proxies/bling.js");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Captura do Body como Raw Buffer ─────────────────────────────────────────
//
// IMPORTANTE: Este middleware deve vir ANTES de qualquer outro parser de body.
//
// Por que raw buffer?
//   - O n8n pode enviar JSON, form-data ou qualquer content-type
//   - Se usarmos express.json(), o body é re-serializado pelo Axios
//     e o Content-Type original pode ser perdido ou modificado
//   - Com raw buffer, repassamos os bytes exatos ao Bling — transparente
//   - O content-length é recalculado automaticamente pelo Axios
//
// req.rawBody fica disponível em todos os proxies downstream.
//
app.use((req, res, next) => {
  const chunks = [];

  req.on("data", (chunk) => chunks.push(chunk));

  req.on("end", () => {
    req.rawBody = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    next();
  });

  req.on("error", (err) => {
    console.error("[BODY] Erro ao ler body:", err.message);
    next(err);
  });
});

// ─── Middleware Global ────────────────────────────────────────────────────────

// Log de todas as requisições
app.use(
  morgan(
    ":remote-addr :method :url :status :response-time ms - :res[content-length]"
  )
);

// ─── Health Check (sem autenticação) ─────────────────────────────────────────
// Usado pelo Railway para verificar se o serviço está vivo
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    apis: {
      bling: { status: "ativo", rateLimit: "3 req/s" },
      // melhorenvio: { status: "inativo" },
    },
  });
});

// ─── Rotas Protegidas por API Key ─────────────────────────────────────────────
//
// O auth middleware valida X-API-Key em TODAS as rotas abaixo.
//
// Proxy do Bling:
//   /bling/<caminho> → https://api.bling.com.br/<caminho>
//
// No n8n, use Authentication: Generic Credential Type → OAuth2 API
// O n8n injeta Authorization: Bearer <token> automaticamente.
// O gateway repassa esse header sem nenhuma modificação.
//
app.use("/bling", auth, blingProxy);

// Quando adicionar Melhor Envio:
// const melhorEnvioProxy = require("./proxies/melhorenvio.js");
// app.use("/melhorenvio", auth, melhorEnvioProxy);

// ─── Rota 404 ─────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: "Rota não encontrada",
    message: `${req.method} ${req.path} não existe neste gateway`,
    rotasDisponiveis: ["/health", "/bling/*"],
  });
});

// ─── Error Handler Global ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("[ERRO GLOBAL]", err.message);
  res.status(500).json({
    error: "Erro interno do servidor",
    message: err.message,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("╔════════════════════════════════════════╗");
  console.log("║          API Gateway - Online          ║");
  console.log("╠════════════════════════════════════════╣");
  console.log(`║  Porta    : ${PORT.toString().padEnd(27)}║`);
  console.log(`║  /bling/* : rate limit 3 req/s          ║`);
  console.log(`║  Auth     : Header X-API-Key            ║`);
  console.log("╚════════════════════════════════════════╝");

  if (!process.env.GATEWAY_API_KEY) {
    console.warn(
      "\n⚠️  AVISO: GATEWAY_API_KEY não definida! O gateway está INSEGURO.\n"
    );
  }
});
