/**
 * API Gateway — Ponto de entrada da aplicação.
 *
 * ─── Fluxo de uma requisição ─────────────────────────────────────────────────
 *
 *  n8n → [express.raw] → [morgan log] → [auth] → [cache GET] → [proxy] → Bling
 *                                                     ↕
 *                                                  [Redis]
 *
 * ─── Rotas disponíveis ───────────────────────────────────────────────────────
 *  GET  /health          → status do servidor e Redis (sem autenticação)
 *  ANY  /bling/*         → proxy para https://api.bling.com.br (requer X-API-Key)
 */

require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const auth = require("./middleware/auth.js");
const adminAuth = require("./middleware/adminAuth.js");
const requestLogger = require("./middleware/requestLogger.js");
const { cache } = require("./middleware/cache.js");
const blingProxy = require("./proxies/bling.js");
const adminRoutes = require("./routes/admin.js");
const { getClient, disconnect } = require("./redis.js");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Inicialização do Redis ───────────────────────────────────────────────────
// O cliente é criado aqui para que a conexão seja estabelecida no startup,
// antes de qualquer requisição chegar.
const redis = getClient();

// ─── Captura do Body como Raw Buffer ─────────────────────────────────────────
// express.raw() com type "*/*" captura qualquer Content-Type como Buffer.
// req.body fica como Buffer — repassado diretamente ao Bling via Axios sem
// re-serialização (preserva Content-Type e encoding originais do n8n).
app.use(
  express.raw({
    type: "*/*",   // captura JSON, form-data, qualquer tipo
    limit: "10mb", // limite de tamanho do body
  })
);

// ─── Log de requisições ───────────────────────────────────────────────────────
app.use(
  morgan(
    ":remote-addr :method :url :status :response-time ms - :res[content-length]"
  )
);

// ─── Log estruturado para Redis + SSE ─────────────────────────────────────────
app.use(requestLogger);

// ─── Health Check ─────────────────────────────────────────────────────────────
// Sem autenticação — usado pelo Railway para verificar se o serviço está vivo.
// Também mostra o status do Redis para diagnóstico rápido.
app.get("/health", async (req, res) => {
  let redisStatus = "desconectado";
  let redisPingMs = null;

  if (redis) {
    try {
      const start = Date.now();
      await redis.ping();
      redisPingMs = Date.now() - start;
      redisStatus = "ok";
    } catch (err) {
      redisStatus = "erro";
      console.error("[HEALTH] Redis ping falhou:", err.message);
    }
  }

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    redis: {
      status: redisStatus,
      pingMs: redisPingMs,
    },
    apis: {
      bling: {
        status: "ativo",
        rateLimit: `${process.env.BLING_MAX_REQUESTS || 2} req / ${process.env.BLING_WINDOW_MS || 1000}ms`,
        cache: "GET 5 min TTL",
      },
    },
  });
});

// ─── Rotas Protegidas por API Key ─────────────────────────────────────────────
//
// Fluxo: auth → cache (apenas GET) → proxy
//
// O middleware `cache("bling")` intercepta GETs com HIT no Redis e responde
// imediatamente, sem nem chegar ao proxy. Em MISS, deixa passar e captura
// a resposta para salvar no Redis antes de enviá-la ao cliente.
//
// ─── Rotas Admin (Ziva OS) ────────────────────────────────────────────────────
app.use("/admin", adminAuth, adminRoutes);

// ─── Rotas Proxy por serviço ──────────────────────────────────────────────────
app.use("/bling", auth, cache("bling"), blingProxy);

// Quando adicionar Melhor Envio:
// const melhorEnvioProxy = require("./proxies/melhorenvio.js");
// app.use("/melhorenvio", auth, cache("melhorenvio"), melhorEnvioProxy);

// ─── 404 ──────────────────────────────────────────────────────────────────────
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

// ─── Startup ──────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  const redisMode = process.env.REDIS_URL ? "Redis (distribuído)" : "Memória local (sem REDIS_URL)";

  console.log("╔════════════════════════════════════════╗");
  console.log("║      API Gateway + Redis - Online      ║");
  console.log("╠════════════════════════════════════════╣");
  console.log(`║  Porta    : ${PORT.toString().padEnd(27)}║`);
  console.log(`║  Rate Limit: ${redisMode.substring(0, 26).padEnd(26)}║`);
  console.log(`║  Cache GET: 5 min TTL (Redis)           ║`);
  console.log(`║  Auth     : Header X-API-Key            ║`);
  console.log("╚════════════════════════════════════════╝");

  if (!process.env.GATEWAY_API_KEY) {
    console.warn(
      "\n⚠️  AVISO: GATEWAY_API_KEY não definida! O gateway está INSEGURO.\n"
    );
  }

  if (!process.env.REDIS_URL) {
    console.warn(
      "\n⚠️  AVISO: REDIS_URL não definida. Rate limiting em memória local.\n" +
      "   Adicione o Redis ao projeto no Railway para ativar o modo distribuído.\n"
    );
  }
});

// ─── Shutdown Gracioso ────────────────────────────────────────────────────────
// O Railway envia SIGTERM antes de parar o container. Aqui encerramos o
// servidor HTTP primeiro (para de aceitar novas conexões) e depois fechamos
// as conexões Redis, garantindo que nenhuma requisição em andamento seja
// interrompida abruptamente.
process.on("SIGTERM", () => {
  console.log("[SHUTDOWN] SIGTERM recebido. Encerrando graciosamente...");
  server.close(async () => {
    await disconnect();
    console.log("[SHUTDOWN] ✅ Encerrado com sucesso.");
    process.exit(0);
  });
});
