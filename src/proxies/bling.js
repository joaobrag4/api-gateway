/**
 * Proxy do Bling ERP.
 *
 * Repassa qualquer método/caminho após /bling para https://api.bling.com.br,
 * com rate limiting de 3 req/s (distribuído via Redis quando disponível)
 * e invalidação automática de cache em operações de escrita.
 *
 * ─── Como configurar no n8n ───────────────────────────────────────────────────
 *
 *  URL Base: https://SEU-GATEWAY.railway.app/bling
 *  (substitui https://api.bling.com.br em todas as chamadas)
 *
 *  Authentication: Generic Credential Type → OAuth2 API
 *    → O n8n injeta automaticamente: Authorization: Bearer <access_token>
 *    → O gateway repassa sem alteração
 *
 *  Header obrigatório: X-API-Key: <GATEWAY_API_KEY>
 *
 * ─── Exemplos de chamadas ──────────────────────────────────────────────────────
 *  GET    /bling/Api/v3/pedidos/vendas          → lista pedidos (cacheado 5min)
 *  GET    /bling/Api/v3/pedidos/vendas/123      → consulta pedido (cacheado 5min)
 *  POST   /bling/Api/v3/pedidos/vendas          → cria pedido (invalida cache)
 *  PUT    /bling/Api/v3/pedidos/vendas/123      → atualiza pedido (invalida cache)
 *  DELETE /bling/Api/v3/pedidos/vendas/123      → remove pedido (invalida cache)
 *  PATCH  /bling/Api/v3/contatos/123            → atualização parcial (invalida cache)
 */

const axios = require("axios");
const { Router } = require("express");
const API_CONFIGS = require("../config/apis.js");
const { getLimiter } = require("../middleware/rateLimit.js");
const { invalidate } = require("../middleware/cache.js");

const router = Router();
const config = API_CONFIGS.bling;

// Rate limiter distribuído via Redis (ou local se Redis indisponível)
const limiter = getLimiter("bling", config.rateLimiter);

/**
 * Executa a requisição real ao Bling preservando method, headers e body.
 *
 * O body é repassado como raw Buffer — não é re-serializado.
 * Isso garante que POST, PUT, PATCH e DELETE com body funcionem
 * exatamente como enviados pelo n8n, sem alterar o Content-Type.
 */
const executeRequest = async (method, path, rawHeaders, rawBody, params) => {
  // Remove headers que não devem ser repassados ao Bling
  const forwardHeaders = { ...rawHeaders };
  config.stripHeaders.forEach((h) => delete forwardHeaders[h.toLowerCase()]);

  // Remove content-length: o axios vai recalcular corretamente com base no body real
  delete forwardHeaders["content-length"];

  const url = `${config.baseUrl}${path}`;
  const hasBody = rawBody && rawBody.length > 0;

  // Log de autenticação para depuração
  const authHeader = forwardHeaders["authorization"];
  const authLog = authHeader
    ? `Auth: ${authHeader.substring(0, 20)}...`
    : "Auth: AUSENTE ⚠️";

  console.log(
    `[BLING] → ${method.toUpperCase()} ${url} | ${authLog} | Body: ${
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
    decompress: true,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  return response;
};

// ─── Rota principal ────────────────────────────────────────────────────────────
// Captura QUALQUER método e caminho após /bling e repassa ao Bling.
router.all("/*", async (req, res) => {
  const path = req.path || "/";
  const method = req.method.toLowerCase();

  // req.body é o Buffer raw capturado pelo express.raw() no index.js
  const rawBody =
    Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;

  const params = req.query;

  try {
    // Aplica rate limiting (distribui pelo Redis se disponível)
    const response = await limiter.schedule(() =>
      executeRequest(method, path, req.headers, rawBody, params)
    );

    console.log(
      `[BLING] ← ${response.status} | ${method.toUpperCase()} ${path}`
    );

    // Invalida cache do recurso quando operações de escrita bem-sucedidas
    const isWriteMethod = ["post", "put", "patch", "delete"].includes(method);
    if (isWriteMethod && response.status < 300) {
      await invalidate("bling", path);
    }

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
