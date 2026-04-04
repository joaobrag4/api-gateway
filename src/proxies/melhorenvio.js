/**
 * Proxy da Melhor Envio.
 *
 * Proxy simples — repassa requisições ao melhorenvio.com.br.
 * O Ziva OS gerencia o token OAuth2 e envia o header Authorization já preenchido.
 *
 * Injeta User-Agent obrigatório pela ME (não é credencial — é identificação do app).
 */

const axios = require("axios");
const { Router } = require("express");
const API_CONFIGS = require("../config/apis.js");
const { getLimiter } = require("../middleware/rateLimit.js");
const { invalidate } = require("../middleware/cache.js");

const router = Router();
const config = API_CONFIGS.melhorenvio;
const limiter = getLimiter("melhorenvio", config.rateLimiter);

async function executeRequest(method, path, rawHeaders, rawBody, params) {
  const forwardHeaders = { ...rawHeaders };
  config.stripHeaders.forEach((h) => delete forwardHeaders[h.toLowerCase()]);
  delete forwardHeaders["content-length"];

  // ME exige User-Agent identificando o app
  forwardHeaders["user-agent"] = "ZivaOS (tech@zivahealth.com.br)";
  forwardHeaders["accept"]     = "application/json";

  const url = `${config.baseUrl}${path}`;
  const hasBody = rawBody && rawBody.length > 0;

  console.log(`[ME] → ${method.toUpperCase()} ${url}`);

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
  });

  return response;
}

router.all("/*", async (req, res) => {
  const path = req.path || "/";
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
