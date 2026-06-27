import { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Application } from 'express';

export interface InjectResponse {
  status: number;
  body: any;
  text: string;
  headers: { get: (name: string) => string | null };
}

interface InjectOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function normalizeHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function encodeBody(headers: Record<string, string>, body: unknown): Buffer | undefined {
  if (body === undefined) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  if (!headers['content-type']) headers['content-type'] = 'application/json';
  return Buffer.from(JSON.stringify(body));
}

export async function inject(app: Application, opts: InjectOptions): Promise<InjectResponse> {
  const headers = normalizeHeaders(opts.headers);
  const body = encodeBody(headers, opts.body);
  if (body && !headers['content-length']) headers['content-length'] = String(body.byteLength);

  const req = Readable.from(body ? [body] : []) as any;
  req.method = opts.method ?? 'GET';
  req.url = opts.path;
  req.originalUrl = opts.path;
  req.headers = headers;
  req.connection = { encrypted: false, remoteAddress: '127.0.0.1' };
  req.socket = req.connection;

  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];

  res.write = ((chunk: unknown, encoding?: BufferEncoding | (() => void), cb?: () => void) => {
    if (chunk !== undefined) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined));
    }
    if (typeof encoding === 'function') encoding();
    if (cb) cb();
    return true;
  }) as typeof res.write;

  res.end = ((chunk?: unknown, encoding?: BufferEncoding | (() => void), cb?: () => void) => {
    if (chunk !== undefined) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined));
    }
    if (typeof encoding === 'function') encoding();
    if (cb) cb();
    process.nextTick(() => res.emit('finish'));
    return res;
  }) as typeof res.end;

  await new Promise<void>((resolve, reject) => {
    res.once('finish', resolve);
    (app as any).handle(req, res as any, (err?: unknown) => (err ? reject(err) : resolve()));
  });

  const text = Buffer.concat(chunks).toString('utf8');
  const responseHeaders = res.getHeaders();
  return {
    status: res.statusCode,
    text,
    body: text ? JSON.parse(text) : undefined,
    headers: { get: (name) => String(responseHeaders[name.toLowerCase()] ?? '') || null },
  };
}
