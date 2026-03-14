/**
 * Módulo Redis — Singleton de conexão.
 *
 * Cria UMA conexão principal e UMA conexão subscriber (necessária para o
 * Bottleneck operar em modo distribuído via Redis Pub/Sub).
 *
 * Modo degradado: se REDIS_URL não estiver definida, getClient() e
 * getSubscriber() retornam null — o sistema continua funcionando com
 * rate limiting em memória local e sem cache.
 */

const Redis = require("ioredis");

let client = null;
let subscriber = null;

const REDIS_URL = process.env.REDIS_URL;

function createClient(name = "main") {
  if (!REDIS_URL) {
    console.warn(
      `[REDIS] REDIS_URL não definida — "${name}" em modo desconectado (degradado)`
    );
    return null;
  }

  const c = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    // Estratégia de reconexão exponencial: 200ms, 400ms, 800ms... até 2s
    retryStrategy: (times) => {
      if (times > 5) {
        console.error(`[REDIS] "${name}" falhou após 5 tentativas de reconexão.`);
        return null; // para de tentar — o app continua sem Redis
      }
      return Math.min(times * 200, 2000);
    },
  });

  c.on("connect", () => console.log(`[REDIS] ✅ Conectado (${name})`));
  c.on("ready", () => console.log(`[REDIS] 🚀 Pronto para uso (${name})`));
  c.on("error", (err) =>
    console.error(`[REDIS] ❌ Erro (${name}): ${err.message}`)
  );
  c.on("close", () => console.warn(`[REDIS] 🔌 Conexão fechada (${name})`));
  c.on("reconnecting", (delay) =>
    console.log(`[REDIS] 🔄 Reconectando (${name}) em ${delay}ms...`)
  );

  return c;
}

/** Retorna (criando se necessário) o cliente Redis principal. */
function getClient() {
  if (!client) client = createClient("main");
  return client;
}

/**
 * Retorna (criando se necessário) o cliente Redis subscriber.
 * O Bottleneck precisa de uma conexão dedicada para Pub/Sub — não pode
 * compartilhar com o cliente que faz operações normais (GET, SET, etc).
 */
function getSubscriber() {
  if (!subscriber) subscriber = createClient("subscriber");
  return subscriber;
}

/**
 * Encerra ambas as conexões Redis graciosamente.
 * Chamado no SIGTERM do processo (Railway envia isso antes de parar o container).
 */
async function disconnect() {
  const promises = [];
  if (client) {
    promises.push(client.quit());
    client = null;
  }
  if (subscriber) {
    promises.push(subscriber.quit());
    subscriber = null;
  }
  await Promise.allSettled(promises);
  console.log("[REDIS] 🔒 Conexões encerradas graciosamente.");
}

module.exports = { getClient, getSubscriber, disconnect };
