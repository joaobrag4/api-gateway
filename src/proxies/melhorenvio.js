/**
 * Proxy da Melhor Envio.
 *
 * Diferente do Bling, a Melhor Envio usa OAuth2 — o gateway gerencia o token
 * automaticamente (cache no Redis, renovação automática a cada 29 dias).
 * O Ziva OS envia as requests sem precisar saber nada sobre autenticação.
 *
 * ─── Variáveis de ambiente obrigatórias ──────────────────────────────────────
 *  ME_CLIENT_ID     — Client ID OAuth2
 *  ME_CLIENT_SECRET — Client Secret OAuth2
 *
 * ─── Exemplos de chamadas (do Ziva OS via gateway) ───────────────────────────
 *  GET  /melhorenvio/api/v2/me/orders/search?q=BR123456789BR
 *  POST /melhorenvio/api/v2/me/shipment/tracking   { "orders": ["..."] }
 */

const axios  = require("axios");
const { Router } = require("express");
const API_CONFIGS  = require("../config/apis.js");
const { getLimiter } = require("../middleware/rateLimit.js");
const { invalidate }  = require("../middleware/cache.js");
const { getClient }   = require("../redis.js");

const router = Router();
const config = API_CONFIGS.melhorenvio;
const limiter = getLimiter("melhorenvio", config.rateLimiter);

// ─── OAuth2 — Gerenciamento de Token ─────────────────────────────────────────

const TOKEN_REDIS_KEY = "gateway:me:access_token";
const TOKEN_TTL_SEC   = 29 * 24 * 60 * 60; // 29 dias (token expira em 30)

/**
 * Retorna o access token da Melhor Envio.
 * Busca no Redis primeiro; se não encontrar, faz a troca OAuth2 e salva.
 */
async function getAccessToken() {
  const redis = getClient();

  // 1. Tenta cache no Redis
  if (redis) {
    try {
      const cached = await redis.get(TOKEN_REDIS_KEY);
      if (cached) return cached;
    } catch { /* ignora falha de leitura */ }
  }

  // 2. Busca novo token via client_credentials
  const clientId     = process.env.ME_CLIENT_ID;
  const clientSecret = process.env.ME_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("ME_CLIENT_ID e ME_CLIENT_SECRET não configurados no gateway");
  }

  console.log("[ME] Buscando novo access token OAuth2...");

  const tokenRes = await axios.post(
    "https://melhorenvio.com.br/oauth/token",
    new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     clientId,
      client_secret: clientSecret,
      scope:         "shipping-tracking read",
    }).toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    }
  );

  const token = tokenRes.data?.access_token;
  if (!token) throw new Error("Melhor Envio não retornou access_token");

  console.log("[ME] Novo token obtido. Salvo no Redis por 29 dias.");

  // 3. Salva no Redis com TTL
  if (redis) {
    try {
      await redis.set(TOKEN_REDIS_KEY, token, "EX", TOKEN_TTL_SEC);
    } catch { /* ignora falha de escrita */ }
  }

  return token;
}

// ─── Execução da request ──────────────────────────────────────────────────────

async function executeRequest(method, path, rawHeaders, rawBody, params) {
  const token = await getAccessToken();

  // Headers limpos + token injetado + User-Agent obrigatório pela ME
  const forwardHeaders = { ...rawHeaders };
  config.stripHeaders.forEach((h) => delete forwardHeaders[h.toLowerCase()]);
  delete forwardHeaders["content-length"];

  forwardHeaders["authorization"] = `Bearer ${token}`;
  forwardHeaders["user-agent"]    = "ZivaOS (tech@zivahealth.com.br)";
  forwardHeaders["accept"]        = "application/json";

  const url     = `${config.baseUrl}${path}`;
  const hasBody = rawBody && rawBody.length > 0;

  console.log(`[ME] → ${method.toUpperCase()} ${url}`);

  const response = await axios({
    method,
    url,
    headers: forwardHeaders,
    data:    hasBody ? rawBody : undefined,
    params,
    validateStatus: () => true,
    timeout: 30000,
    responseType: "json",
    decompress: true,
  });

  // Se o token expirou (401), limpa o cache e retenta uma vez
  if (response.status === 401) {
    console.warn("[ME] Token expirado (401). Renovando...");
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
    });
  }

  return response;
}

// ─── Rota principal ───────────────────────────────────────────────────────────

router.all("/*", async (req, res) => {
  const path   = req.path || "/";
  const method = req.method.toLowerCase();
  const rawBody = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;

  try {
    const response = await limiter.schedule(() =>
      executeRequest(method, path, req.headers, rawBody, req.query)
    );

    console.log(`[ME] ← ${response.status} | ${method.toUpperCase()} ${path}`);

    const isWrite = ["post", "put", "patch", "delete"].includes(method);
    if (isWrite && response.status < 300) {
      await invalidate("melhorenvio", path);
    }

    return res.status(response.status).json(response.data);
  } catch (error) {
    console.error(`[ME] Erro: ${error.message}`);

    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      return res.status(504).json({ error: "Gateway Timeout", message: "Melhor Envio não respondeu em 30s", path });
    }
    if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED") {
      return res.status(503).json({ error: "Service Unavailable", message: "Não foi possível conectar à Melhor Envio", path });
    }

    return res.status(502).json({ error: "Bad Gateway", message: error.message, path });
  }
});

module.exports = router;
