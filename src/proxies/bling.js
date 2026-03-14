const axios = require("axios");
const Bottleneck = require("bottleneck");
const { Router } = require("express");
const API_CONFIGS = require("../config/apis.js");

const router = Router();
const config = API_CONFIGS.bling;

/**
 * Rate limiter do Bling: máximo 3 requisições por segundo.
 */
const limiter = new Bottleneck(config.rateLimiter);

limiter.on("queued", (info) => {
  console.log(`[BLING] Enfileirada. Pendentes na fila: ${info.size}`);
});

limiter.on("error", (error) => {
  console.error("[BLING] Erro no rate limiter:", error);
});

/**
 * Executa a requisição real ao Bling preservando method, headers e body.
 *
 * O body é repassado como raw Buffer — não é re-serializado.
 * Isso garante que POST, PUT, PATCH e DELETE com body funcionem
 * exatamente como enviados pelo n8n, sem alterar o Content-Type.
 */
const executeRequest = async (method, path, rawHeaders, rawBody, params) => {
  // Headers a remover antes de repassar ao Bling
  const forwardHeaders = { ...rawHeaders };
  config.stripHeaders.forEach((h) => delete forwardHeaders[h.toLowerCase()]);

  // Remove content-length: o axios vai recalcular com base no body real
  delete forwardHeaders["content-length"];

  const url = `${config.baseUrl}${path}`;
  const hasBody = rawBody && rawBody.length > 0;

  // Log detalhado para depuração
  const authHeader = forwardHeaders["authorization"];
  const authLog = authHeader
    ? `Auth: ${authHeader.substring(0, 20)}...`
    : "Auth: AUSENTE ⚠️";

  console.log(
    `[BLING] ${method.toUpperCase()} ${url} | ${authLog} | Body: ${
      hasBody ? rawBody.length + " bytes" : "nenhum"
    }`
  );

  const response = await axios({
    method,
    url,
    headers: forwardHeaders,
    // Para GET/HEAD sem body, não envia data — para os demais, raw buffer
    data: hasBody ? rawBody : undefined,
    params,
    // Não lança exceção em erros HTTP (4xx, 5xx) — repassa a resposta original
    validateStatus: () => true,
    timeout: 30000,
    responseType: "json",
    // Não decomprimir resposta — repassa como veio
    decompress: true,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  return response;
};

/**
 * Rota principal: captura QUALQUER método e caminho após /bling
 * e repassa ao Bling com rate limiting de 3 req/s.
 *
 * ─── Como configurar no n8n ───────────────────────────────────────────────
 *
 * URL: https://SEU-GATEWAY.railway.app/bling/Api/v3/pedidos/vendas
 *      (substitui https://api.bling.com.br)
 *
 * Authentication: Generic Credential Type → OAuth2 API
 *   → O n8n injeta automaticamente: Authorization: Bearer <token>
 *   → O gateway repassa esse header sem alteração
 *
 * Headers adicionais obrigatórios:
 *   X-API-Key: <sua GATEWAY_API_KEY>
 *
 * ─── Métodos suportados ───────────────────────────────────────────────────
 *   GET    /bling/Api/v3/pedidos/vendas          → lista pedidos
 *   GET    /bling/Api/v3/pedidos/vendas/123      → consulta pedido
 *   POST   /bling/Api/v3/pedidos/vendas          → cria pedido (com JSON body)
 *   PUT    /bling/Api/v3/pedidos/vendas/123      → atualiza pedido (com JSON body)
 *   DELETE /bling/Api/v3/pedidos/vendas/123      → remove pedido
 *   PATCH  /bling/Api/v3/contatos/123            → atualização parcial
 */
router.all("/*", async (req, res) => {
  const path = req.path || "/";
  const method = req.method.toLowerCase();

  // req.body é o Buffer raw capturado pelo express.raw() no index.js
  // Para GET/HEAD sem body, express.raw() deixa req.body como undefined
  const rawBody = Buffer.isBuffer(req.body) && req.body.length > 0
    ? req.body
    : undefined;

  const params = req.query;

  try {
    const response = await limiter.schedule(() =>
      executeRequest(method, path, req.headers, rawBody, params)
    );

    console.log(
      `[BLING] ← ${response.status} | ${method.toUpperCase()} ${path}`
    );

    // Repassa status code e body exatos do Bling
    return res.status(response.status).json(response.data);
  } catch (error) {
    console.error(`[BLING] Erro de conexão: ${error.message}`);

    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      return res.status(504).json({
        error: "Gateway Timeout",
        message: "O Bling não respondeu dentro do tempo limite (30s)",
        path,
      });
    }

    if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED") {
      return res.status(503).json({
        error: "Service Unavailable",
        message: "Não foi possível conectar à API do Bling",
        path,
      });
    }

    return res.status(502).json({
      error: "Bad Gateway",
      message: "Falha ao conectar com a API do Bling",
      details: error.message,
      path,
    });
  }
});

module.exports = router;
