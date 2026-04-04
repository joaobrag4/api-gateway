/**
 * Proxy da Melhor Rastreio (GraphQL).
 *
 * A Melhor Rastreio usa Keycloak JWT. Estratégia de token (em ordem):
 *  1. Redis cache (access_token, 28 dias)
 *  2. refreshToken mutation GraphQL (usa refresh_token salvo no Redis)
 *  3. loginLongLivedToken mutation (username + password — só funciona com conta email/senha)
 *  4. MR_ACCESS_TOKEN env var (fallback estático — válido 30 dias)
 *
 * ─── Variáveis de ambiente (Railway) ─────────────────────────────────────────
 *  MR_ACCESS_TOKEN — token estático (fallback; corrigir typo: não é MR_ACESS_TOKEN)
 *  MR_USERNAME     — email da conta com senha própria (não funciona com conta Google)
 *  MR_PASSWORD     — senha da conta
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

const TOKEN_REDIS_KEY   = "gateway:mr:access_token";
const REFRESH_REDIS_KEY = "gateway:mr:refresh_token";
const TOKEN_TTL_SEC     = 28 * 24 * 60 * 60; // 28 dias
const REFRESH_TTL_SEC   = 55 * 24 * 60 * 60; // 55 dias

const GRAPHQL_URL = config.baseUrl + "/graphql";

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

  // 2. refreshToken mutation (sem precisar de senha)
  if (redis) {
    try {
      const storedRefresh = await redis.get(REFRESH_REDIS_KEY);
      if (storedRefresh) {
        const result = await callRefreshToken(storedRefresh);
        if (result) {
          await cacheTokens(redis, result.accessToken, result.refreshToken, result.expiresIn);
          return result.accessToken;
        }
      }
    } catch { /* ignora */ }
  }

  // 3. loginLongLivedToken (só funciona com conta email/senha — não Google OAuth)
  const username = process.env.MR_USERNAME;
  const password = process.env.MR_PASSWORD;
  if (username && password) {
    try {
      const result = await callLoginLongLivedToken(username, password);
      if (result) {
        await cacheTokens(redis, result.accessToken, result.refreshToken, result.expiresIn);
        return result.accessToken;
      }
    } catch (err) {
      console.warn("[MR] loginLongLivedToken falhou:", err.message);
    }
  }

  // 4. Fallback: MR_ACCESS_TOKEN estático
  const staticToken = process.env.MR_ACCESS_TOKEN;
  if (staticToken) {
    console.warn("[MR] Usando MR_ACCESS_TOKEN estático. Salvar no Redis para evitar expiração.");
    // Salva no Redis para as próximas requisições (evita ler env toda vez)
    if (redis) {
      try { await redis.set(TOKEN_REDIS_KEY, staticToken, "EX", TOKEN_TTL_SEC); } catch { /* ignora */ }
    }
    return staticToken;
  }

  throw new Error(
    "[MR] Nenhuma credencial disponível. " +
    "Corrija o typo no Railway: MR_ACESS_TOKEN → MR_ACCESS_TOKEN, " +
    "ou configure MR_USERNAME + MR_PASSWORD (conta com senha, não Google)."
  );
}

/**
 * Chama a mutation refreshToken do GraphQL da Melhor Rastreio.
 * Não requer Bearer auth — usa apenas o refresh_token.
 */
async function callRefreshToken(refreshToken) {
  console.log("[MR] Renovando token via refreshToken mutation...");
  const res = await axios.post(
    GRAPHQL_URL,
    {
      query: `query refreshToken($token: String!) {
        refreshToken(token: $token) {
          accessToken
          refreshToken
          expiresIn
        }
      }`,
      variables: { token: refreshToken },
    },
    {
      headers: { "Content-Type": "application/json", "User-Agent": "ZivaOS (tech@zivahealth.com.br)" },
      timeout: 15000,
    }
  );

  const data = res.data?.data?.refreshToken;
  if (!data?.accessToken) {
    console.warn("[MR] refreshToken mutation não retornou accessToken:", res.data?.errors);
    return null;
  }
  console.log("[MR] Token renovado via refreshToken mutation.");
  return data;
}

/**
 * Faz login via loginLongLivedToken.
 * Atenção: só funciona com contas criadas com email + senha no Melhor Rastreio.
 * Contas criadas via Google OAuth vão dar timeout (Keycloak tenta federar com Google).
 */
async function callLoginLongLivedToken(username, password) {
  console.log("[MR] Buscando token via loginLongLivedToken...");
  const res = await axios.post(
    GRAPHQL_URL,
    {
      query: `query loginLongLivedToken($username: String!, $password: String!) {
        loginLongLivedToken(username: $username, password: $password) {
          accessToken
          refreshToken
          expiresIn
        }
      }`,
      variables: { username, password },
    },
    {
      headers: { "Content-Type": "application/json", "User-Agent": "ZivaOS (tech@zivahealth.com.br)" },
      timeout: 10000, // 10s — timeout rápido para não travar em contas Google
    }
  );

  const data = res.data?.data?.loginLongLivedToken;
  if (!data?.accessToken) {
    console.warn("[MR] loginLongLivedToken sem accessToken:", res.data?.errors);
    return null;
  }
  console.log("[MR] Token obtido via loginLongLivedToken.");
  return data;
}

async function cacheTokens(redis, accessToken, refreshToken, expiresInSeconds) {
  if (!redis) return;
  const ttl = expiresInSeconds ? Math.floor(expiresInSeconds * 0.93) : TOKEN_TTL_SEC;
  try {
    await redis.set(TOKEN_REDIS_KEY, accessToken, "EX", ttl);
    if (refreshToken) {
      await redis.set(REFRESH_REDIS_KEY, refreshToken, "EX", REFRESH_TTL_SEC);
    }
  } catch { /* ignora */ }
}

// ─── Seed inicial: salva o refresh_token do token estático no Redis ───────────
// Quando MR_ACCESS_TOKEN tem um JWT válido que contém um refresh_token associado,
// precisamos de uma chamada inicial para popular o Redis. Isso é feito via
// POST /admin/mr/seed-token no gateway.

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

  // 401 → limpa access_token do Redis e retenta (o refresh_token fica)
  if (response.status === 401) {
    console.warn("[MR] Token expirado (401). Limpando cache e renovando...");
    const redis = getClient();
    if (redis) await redis.del(TOKEN_REDIS_KEY).catch(() => {});

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
