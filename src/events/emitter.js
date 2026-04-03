/**
 * EventEmitter central compartilhado entre requestLogger e admin/stream.
 *
 * Eventos emitidos:
 *   'request' — { id, service, method, path, status, durationMs, timestamp, cached }
 */

const { EventEmitter } = require("events");

const emitter = new EventEmitter();
emitter.setMaxListeners(50); // suporta até 50 clientes SSE simultâneos

module.exports = emitter;
