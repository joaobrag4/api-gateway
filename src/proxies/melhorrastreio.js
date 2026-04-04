/**
 * Proxy da Melhor Rastreio (GraphQL).
 *
 * Proxy simples — repassa requisições ao melhor-rastreio-api.melhorrastreio.com.br.
 * O Ziva OS gerencia o JWT Keycloak e envia o header Authorization já preenchido.
 *
 * Injeta User-Agent identificando o app (não é credencial).
 */

const axios = require("axios");
const { Router } = require("express");
const API_CONFIGS = require("../config/apis.js");
const { getLimiter } = require("../middleware/rateLimit.js");
const { getClient } = require("../redis.js");

const router = Router();
const config = API_CONFIGS.melhorrastreio;
const limiter = getLimiter("melhorrastreio", config.rateLimiter);

async function executeRequest(method, path, rawHeaders, rawBody) {
  const forwardHeaders = { ...rawHeaders };
  config.stripHeaders.forEach((h) => delete forwardHeaders[h.toLowerCase()]);
  delete forwardHeaders["content-length"];

  forwardHeaders["user-agent"]   = "ZivaOS (tech@zivahealth.com.br)";
  forwardHeaders["accept"]       = "application/json";
  forwardHeaders["content-type"] = "application/json";

  const url = `${config.baseUrl}${path}`;
  const hasBody = rawBody && rawBody.length > 0;

  console.log(`[MR] → ${method.toUpperCase()} ${url}`);

  const response = await axios({
    method,
    url,
    headers: forwardHeaders,
    data: hasBody ? rawBody : undefined,
    validateStatus: () => true,
    timeout: 30000,
    responseType: "json",
    decompress: true,
  });

  return response;
}

router.all("/*", async (req, res) => {
  const path = req.path || "/";
  const method = req.method.toLowerCase();
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
