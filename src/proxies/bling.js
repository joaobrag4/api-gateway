/**
 * Proxy do Bling ERP.
 *
 * Gerencia automaticamente o token OAuth2 do Bling:
 *  1. Redis cache (access_token, ~6h)
 *  2. Refresh via POST /Api/v3/oauth/token (refresh_token grant)
 *
 * ─── Variáveis de ambiente (Railway) ─────────────────────────────────────────
 *  BLING_CLIENT_ID      — client_id do app OAuth2 Bling
 *  BLING_CLIENT_SECRET  — client_secret do app OAuth2 Bling
 *  BLING_REFRESH_TOKEN  — refresh_token inicial (obtido na primeira autorização)
 *  BLING_API_TOKEN      — fallback estático (token fixo, sem renovação automática)
 *  BLING_WINDOW_MS      — janela de tempo em ms        (padrão: 1000)
 *  BLING_MAX_REQUESTS   — requisições por janela       (padrão: 2)
 *
 * ─── Exemplos de chamadas ──────────────────────────────────────────────────────
 *  GET    /bling/Api/v3/pedidos/vendas          → lista pedidos (cacheado 5min)
 *  GET    /bling/Api/v3/pedidos/vendas/123      → consulta pedido (cacheado 5min)
 *  POST   /bling/Api/v3/pedidos/vendas          → cria pedido (invalida cache)
 *  PUT    /bling/Api/v3/pedidos/vendas/123      → atualiza pedido (invalida cache)
 */

const axios = require("axios");
const { Router } = require("express");
const API_CONFIGS = require("../config/apis.js");
const { getLimiter } = require("../middleware/rateLimit.js");
const { invalidate } = require("../middleware/cache.js");
const { getClient } = require("../redis.js");

const router = Router();
const config = API_CONFIGS.bling;

// Rate limiter distribuído via Redis (ou local se Redis indisponível)
const limiter = getLimiter("bling", config.rateLimiter);

const TOKEN_REDIS_KEY   = "gateway:bling:access_token";
const REFRESH_REDIS_KEY = "gateway:bling:refresh_token";
const TOKEN_TTL_SEC     = 21000; // 21000s ≈ 5h50min (Bling expira em 6h; margem de 10min)

// ─── Token — Gerenciamento ────────────────────────────────────────────────────

async function getAccessToken() {
  const redis = getClient();

  // 1. Cache Redis
  if (redis) {
    try {
      const cached = await redis.get(TOKEN_REDIS_KEY);
      if (cached) return cached;
    } catch { /* ignora */ }
  }

  // 2. Refresh via OAuth2 (client_id + client_secret + refresh_token)
  const clientId     = process.env.BLING_CLIENT_ID;
  const clientSecret = process.env.BLING_CLIENT_SECRET;
  const refreshToken = await getStoredRefreshToken(redis);

  if (clientId && clientSecret && refreshToken) {
    try {
      const result = await callRefreshToken(clientId, clientSecret, refreshToken);
      if (result) {
        await cacheTokens(redis, result.accessToken, result.refreshToken);
        return result.accessToken;
      }
    } catch (err) {
      console.warn("[BLING] Refresh OAuth2 falhou:", err.message);
    }
  }

  // 3. Fallback: BLING_API_TOKEN estático
  const staticToken = process.env.BLING_API_TOKEN;
  if (staticToken) {
    console.warn("[BLING] Usando BLING_API_TOKEN estático. Configure BLING_CLIENT_ID + BLING_CLIENT_SECRET + BLING_REFRESH_TOKEN para renovação automática.");
    if (redis) {
      try { await redis.set(TOKEN_REDIS_KEY, staticToken, "EX", TOKEN_TTL_SEC); } catch { /* ignora */ }
    }
    return staticToken;
  }

  throw new Error("[BLING] Nenhuma credencial disponível. Configure BLING_CLIENT_ID, BLING_CLIENT_SECRET e BLING_REFRESH_TOKEN no Railway.");
}

async function getStoredRefreshToken(redis) {
  // Tenta Redis primeiro; fallback para env var
  if (redis) {
    try {
      const stored = await redis.get(REFRESH_REDIS_KEY);
      if (stored) return stored;
    } catch { /* ignora */ }
  }
  return process.env.BLING_REFRESH_TOKEN || null;
}

/**
 * Renova o access_token do Bling via refresh_token grant.
 * Bling OAuth2: POST /Api/v3/oauth/token
 *   Authorization: Basic base64(client_id:client_secret)
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: grant_type=refresh_token&refresh_token=<token>
 *
 * Retorna: { access_token, refresh_token, expires_in, token_type }
 */
async function callRefreshToken(clientId, clientSecret, refreshToken) {
  console.log("[BLING] Renovando token OAuth2 via refresh_token...");

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await axios.post(
    "https://api.bling.com.br/Api/v3/oauth/token",
    new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept:         "application/json",
      },
      timeout: 15000,
    }
  );

  const data = res.data;
  if (!data?.access_token) {
    console.warn("[BLING] Refresh não retornou access_token:", data);
    return null;
  }

  console.log("[BLING] Token renovado com sucesso. Expira em:", data.expires_in, "s");
  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token || null, // Bling pode ou não rotacionar o refresh_token
    expiresIn:    data.expires_in || 21600,
  };
}

async function cacheTokens(redis, accessToken, refreshToken) {
  if (!redis) return;
  try {
    await redis.set(TOKEN_REDIS_KEY, accessToken, "EX", TOKEN_TTL_SEC);
    if (refreshToken) {
      // Refresh token do Bling não tem TTL documentado — guardamos por 180 dias
      await redis.set(REFRESH_REDIS_KEY, refreshToken, "EX", 180 * 24 * 60 * 60);
    }
  } catch { /* ignora */ }
}

// ─── Execução da requisição ───────────────────────────────────────────────────

const executeRequest = async (method, path, rawHeaders, rawBody, params) => {
  const token = await getAccessToken();

  // Remove headers que não devem ser repassados ao Bling
  const forwardHeaders = { ...rawHeaders };
  config.stripHeaders.forEach((h) => delete forwardHeaders[h.toLowerCase()]);

  // Remove content-length: o axios vai recalcular corretamente com base no body real
  delete forwardHeaders["content-length"];

  // Injeta token gerenciado pelo gateway (sobrescreve qualquer Authorization enviada pelo cliente)
  forwardHeaders["authorization"] = `Bearer ${token}`;

  const url = `${config.baseUrl}${path}`;
  const hasBody = rawBody && rawBody.length > 0;

  console.log(
    `[BLING] → ${method.toUpperCase()} ${url} | Auth: Bearer ${token.substring(0, 8)}... | Body: ${
      hasBody ? rawBody.length + " bytes" : "nenhum"
    }`
  );

  const response = await axios({
    method,
    url,
    headers: forwardHeaders,
    data: hasBody ? rawBody : undefined,
    params,
    validateStatus: () => true,
    timeout: 30000,
    responseType: "json",
    decompress: true,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  // 401 → limpa access_token do Redis e retenta (mantém refresh_token)
  if (response.status === 401) {
    console.warn("[BLING] Token expirado (401). Limpando cache e renovando...");
    const redis = getClient();
    if (redis) await redis.del(TOKEN_REDIS_KEY).catch(() => {});

    const newToken = await getAccessToken();
    forwardHeaders["authorization"] = `Bearer ${newToken}`;

    return axios({
      method, url,
      headers: forwardHeaders,
      data: hasBody ? rawBody : undefined,
      params,
      validateStatus: () => true,
      timeout: 30000,
      responseType: "json",
      decompress: true,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  }

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
