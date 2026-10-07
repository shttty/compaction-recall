// Preload before the SDK or any package code. No transport may escape offline preflight/compression.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

const blocked = () => { throw new Error('BENCHMARK_NETWORK_FORBIDDEN'); };
net.Socket.prototype.connect = blocked;
net.connect = net.createConnection = tls.connect = blocked;
http.request = http.get = https.request = https.get = http2.connect = blocked;
dgram.Socket.prototype.send = blocked;
for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const key of Object.getOwnPropertyNames(target)) {
    if (/^(lookup|resolve|reverse)/.test(key) && typeof target[key] === 'function') target[key] = blocked;
  }
}
for (const key of ['fetch', 'WebSocket', 'EventSource']) {
  if (key === 'fetch' || key in globalThis) globalThis[key] = blocked;
}
syncBuiltinESMExports();
// Node children inherit this guard even after the helper removes the caller's environment.
globalThis[Symbol.for('benchmark.noNetworkPreload')] = import.meta.url;
process.env.NODE_OPTIONS = `--import=${import.meta.url}`;
