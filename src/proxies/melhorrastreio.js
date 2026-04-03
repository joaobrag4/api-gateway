/**
 * Proxy da Melhor Rastreio (GraphQL).
 *
 * A Melhor Rastreio usa Keycloak JWT — o gateway gerencia o token
 * automaticamente (cache no Redis, renovação automática via loginLongLivedToken
 * ou Keycloak refresh_token endpoint).
 *
 * ─── Variáveis de ambiente obrigatórias ──────────────────────────────────────
 *  MR_USERNAME — email/usuário da conta Melhor Rastreio
 *  MR_PASSWORD — senha da conta Melhor Rastreio
 *
 * ─── Variável opcional (bypass inicial) ──────────────────────────────────────
 *  MR_ACCESS_TOKEN — token estático para usar sem renovação automática
 *
 * ─── Exemplos de chamadas (do Ziva OS via gateway) ───────────────────────────
 *  POST /melhorrastreio/graphql   { "query": "...", "variables": {...} }
 */

const axios       = require("axios");
const { Router }  = require("express");
const API_CONFIGS = require("../config/apis.js");
const { getLimiter }  = require("../middleware/rateLimit.js");
const { getClient }   = require("../redis.js");

const router  = Router();
const config  = API_CONFIGS.melhorrastreio;
const limiter = getLimiter("melhorrastreio", config.rateLimiter);

// ─── Token — Gerenciamento ────────────────────────────────────────────────────

const TOKEN_REDIS_KEY   = "gateway:mr:access_token";
const REFRESH_REDIS_KEY = "gateway:mr:refresh_token";
const TOKEN_TTL_SEC     = 28 * 24 * 60 * 60; // 28 dias (token expira em 30)
const REFRESH_TTL_SEC   = 60 * 24 * 60 * 60; // 60 dias para o refresh_token

const GRAPHQL_URL   = config.baseUrl + "/graphql";
const KEYCLOAK_URL  =
  "https://keycloak-external.melhorenvio.com.br" +
  "/auth/realms/melhor-rastreio/protocol/openid-connect/token";

/**
 * Retorna o access token da Melhor Rastreio.
 * Prioridade:
 *  1. Redis cache (access_token)
 *  2. Keycloak refresh_token (se armazenado no Redis)
 *  3. loginLongLivedToken mutation (username + password)
 *  4. MR_ACCESS_TOKEN env var (fallback estático)
 */
async function getAccessToken() {
  const redis = getClient();

  // 1. Cache Redis
  if (redis) {
    try {
      const cached = await redis.get(TOKEN_REDIS_KEY);
      if (cached) return cached;
    } catch { /* ignora */ }
  }

  // 2. Keycloak refresh_token
  if (redis) {
    try {
      const storedRefresh = await redis.get(REFRESH_REDIS_KEY);
      if (storedRefresh) {
        const refreshed = await refreshViaKeycloak(storedRefresh, redis);
        if (refreshed) return refreshed;
      }
    } catch { /* ignora */ }
  }

  // 3. loginLongLivedToken (username + password)
  const username = process.env.MR_USERNAME;
  const password = process.env.MR_PASSWORD;

  if (username && password) {
    const token = await loginLongLivedToken(username, password, redis);
    if (token) return token;
  }

  // 4. Fallback estático
  const staticToken = process.env.MR_ACCESS_TOKEN;
  if (staticToken) {
    console.warn("[MR] Usando MR_ACCESS_TOKEN estático (sem renovação automática).");
    return staticToken;
  }

  throw new Error(
    "Melhor Rastreio: nenhuma credencial disponível. " +
    "Configure MR_USERNAME + MR_PASSWORD ou MR_ACCESS_TOKEN no Railway."
  );
}

async function refreshViaKeycloak(refreshToken, redis) {
  try {
    console.log("[MR] Tentando refresh via Keycloak...");
    const res = await axios.post(
      KEYCLOAK_URL,
      new URLSearchParams({
        grant_type:    "refresh_token",
        client_id:     "api",
        refresh_token: refreshToken,
      }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15000,
      }
    );

    const { access_token, refresh_token, expires_in } = res.data;
    if (!access_token) return null;

    const ttl = expires_in ? Math.floor(expires_in * 0.95) : TOKEN_TTL_SEC;
    await cacheTokens(redis, access_token, refresh_token || refreshToken, ttl);
    console.log("[MR] Token renovado via Keycloak.");
    return access_token;
  } catch (err) {
    console.warn("[MR] Falha no refresh via Keycloak:", err.message);
    return null;
  }
}

async function loginLongLivedToken(username, password, redis) {
  try {
    console.log("[MR] Buscando novo token via loginLongLivedToken...");

    const res = await axios.post(
      GRAPHQL_URL,
      {
        query: `query loginLongLivedToken($username: String!, $password: String!) {
          loginLongLivedToken(username: $username, password: $password)
        }`,
        variables: { username, password },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "ZivaOS (tech@zivahealth.com.br)",
        },
        timeout: 15000,
      }
    );

    const token = res.data?.data?.loginLongLivedToken;
    if (!token) {
      console.error("[MR] loginLongLivedToken não retornou token:", res.data?.errors);
      return null;
    }

    // Tenta extrair refresh_token se o payload vier com mais dados
    const refreshToken = res.data?.data?.refreshToken || null;
    await cacheTokens(redis, token, refreshToken, TOKEN_TTL_SEC);
    console.log("[MR] Novo token obtido via loginLongLivedToken.");
    return token;
  } catch (err) {
    console.error("[MR] Falha em loginLongLivedToken:", err.message);
    return null;
  }
}

async function cacheTokens(redis, accessToken, refreshToken, ttlSeconds) {
  if (!redis) return;
  try {
    await redis.set(TOKEN_REDIS_KEY, accessToken, "EX", ttlSeconds);
    if (refreshToken) {
      await redis.set(REFRESH_REDIS_KEY, refreshToken, "EX", REFRESH_TTL_SEC);
    }
  } catch { /* ignora */ }
}

// ─── Execução da request ──────────────────────────────────────────────────────

async function executeRequest(method, path, rawHeaders, rawBody) {
  const token = await getAccessToken();

  const forwardHeaders = { ...rawHeaders };
  config.stripHeaders.forEach((h) => delete forwardHeaders[h.toLowerCase()]);
  delete forwardHeaders["content-length"];

  forwardHeaders["authorization"] = `Bearer ${token}`;
  forwardHeaders["user-agent"]    = "ZivaOS (tech@zivahealth.com.br)";
  forwardHeaders["accept"]        = "application/json";
  forwardHeaders["content-type"]  = "application/json";

  const url     = `${config.baseUrl}${path}`;
  const hasBody = rawBody && rawBody.length > 0;

  console.log(`[MR] → ${method.toUpperCase()} ${url}`);

  const response = await axios({
    method,
    url,
    headers: forwardHeaders,
    data:    hasBody ? rawBody : undefined,
    validateStatus: () => true,
    timeout: 30000,
    responseType: "json",
    decompress: true,
  });

  // 401 → limpa cache e retenta uma vez
  if (response.status === 401) {
    console.warn("[MR] Token expirado (401). Renovando...");
    const redis = getClient();
    if (redis) {
      await redis.del(TOKEN_REDIS_KEY).catch(() => {});
    }

    const newToken = await getAccessToken();
    forwardHeaders["authorization"] = `Bearer ${newToken}`;

    return axios({
      method, url,
      headers: forwardHeaders,
      data: hasBody ? rawBody : undefined,
      validateStatus: () => true,
      timeout: 30000,
      responseType: "json",
    });
  }

  return response;
}

// ─── Rota principal ───────────────────────────────────────────────────────────

router.all("/*", async (req, res) => {
  const path    = req.path || "/";
  const method  = req.method.toLowerCase();
  const rawBody = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;

  try {
    const response = await limiter.schedule(() =>
      executeRequest(method, path, req.headers, rawBody)
    );

    console.log(`[MR] ← ${response.status} | ${method.toUpperCase()} ${path}`);

    return res.status(response.status).json(response.data);
  } catch (error) {
    console.error(`[MR] Erro: ${error.message}`);

    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      return res.status(504).json({ error: "Gateway Timeout", message: "Melhor Rastreio não respondeu em 30s", path });
    }
    if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED") {
      return res.status(503).json({ error: "Service Unavailable", message: "Não foi possível conectar à Melhor Rastreio", path });
    }

    return res.status(502).json({ error: "Bad Gateway", message: error.message, path });
  }
});

module.exports = router;
