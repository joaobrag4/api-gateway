/**
 * Proxy do Bling ERP.
 *
 * Proxy simples — repassa qualquer método/caminho após /bling para https://api.bling.com.br.
 * O Ziva OS gerencia o token OAuth2 e envia o header Authorization já preenchido.
 *
 * Rate limiting de 3 req/s (distribuído via Redis quando disponível).
 * Invalida cache em operações de escrita.
 */

const axios = require("axios");
const { Router } = require("express");
const API_CONFIGS = require("../config/apis.js");
const { getLimiter } = require("../middleware/rateLimit.js");
const { invalidate } = require("../middleware/cache.js");

const router = Router();
const config = API_CONFIGS.bling;
const limiter = getLimiter("bling", config.rateLimiter);

const executeRequest = async (method, path, rawHeaders, rawBody, params) => {
  const forwardHeaders = { ...rawHeaders };
  config.stripHeaders.forEach((h) => delete forwardHeaders[h.toLowerCase()]);
  delete forwardHeaders["content-length"];

  const url = `${config.baseUrl}${path}`;
  const hasBody = rawBody && rawBody.length > 0;

  const authLog = forwardHeaders["authorization"]
    ? `Bearer ${forwardHeaders["authorization"].substring(7, 15)}...`
    : "AUSENTE ⚠️";

  console.log(`[BLING] → ${method.toUpperCase()} ${url} | Auth: ${authLog}`);

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

  return response;
};

router.all("/*", async (req, res) => {
  const path = req.path || "/";
  const method = req.method.toLowerCase();
  const rawBody = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;

  try {
    const response = await limiter.schedule(() =>
      executeRequest(method, path, req.headers, rawBody, req.query)
    );

    console.log(`[BLING] ← ${response.status} | ${method.toUpperCase()} ${path}`);

    const isWriteMethod = ["post", "put", "patch", "delete"].includes(method);
    if (isWriteMethod && response.status < 300) {
      await invalidate("bling", path);
    }

    return res.status(response.status).json(response.data);
  } catch (error) {
    console.error(`[BLING] Erro de conexão: ${error.message}`);

    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      return res.status(504).json({ error: "Gateway Timeout", message: "O Bling não respondeu dentro do tempo limite (30s)", path });
    }
    if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED") {
      return res.status(503).json({ error: "Service Unavailable", message: "Não foi possível conectar à API do Bling", path });
    }

    return res.status(502).json({ error: "Bad Gateway", message: error.message, path });
  }
});

module.exports = router;
