import { randomUUID } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { getDatabase } from '@netlify/database';
import { getUser, verifyRequestOrigin } from '@netlify/identity';
import type { Config, Context } from '@netlify/server';
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/netlify-db';
import { motivationItems } from '../../db/schema.ts';

const route = '/api/motivation';
export const config: Config = { path: ['/api/motivation', '/api/motivation/*'] };
const itemPath = /^\/api\/motivation\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(\/media)?$/;

const maxFileBytes = 20 * 1024 * 1024;
const maxLibraryBytes = 100 * 1024 * 1024;
const maxItems = 60;
const privateHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const files = () => getStore({ name: 'motivation-media', consistency: 'strong' });
const connect = () => drizzle({ client: getDatabase() });
let database: ReturnType<typeof connect> | undefined;
const db = () => database ??= connect();
const publicColumns = {
  id: motivationItems.id, category: motivationItems.category, kind: motivationItems.kind,
  title: motivationItems.title, content: motivationItems.content, createdAt: motivationItems.createdAt,
};

class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: privateHeaders });
}

async function owner(context: Context) {
  const token = context.cookies.get('nf_jwt');
  if (!token) return null;
  const user = await getUser();
  if (user?.id) return user.id;
  const siteUrl = process.env.URL || context.site.url;
  if (!siteUrl) throw new RequestError(503, 'Sign-in check is unavailable. Please try again.');
  const identityUrl = new URL('/.netlify/identity/user', siteUrl);
  identityUrl.protocol = 'https:';
  const verified = await fetch(identityUrl, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (verified.status === 401 || verified.status === 403) return null;
  if (!verified.ok) throw new RequestError(503, 'Sign-in check is unavailable. Please try again.');
  const profile = await verified.json();
  return typeof profile.id === 'string' && profile.id ? profile.id : null;
}

async function readBody(request: Request, limit: number) {
  if (Number(request.headers.get('Content-Length')) > limit) {
    throw new RequestError(413, 'This upload is too large.');
  }
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.length;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new RequestError(413, 'This upload is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function getTitle(value: unknown) {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || title.length > 100) throw new RequestError(400, 'Add a title of up to 100 characters.');
  return title;
}

function getMediaType(category: 'song' | 'video', bytes: Buffer) {
  if (bytes.length < 12) return null;
  const isMp4 = bytes.toString('ascii', 4, 8) === 'ftyp';
  if (category === 'video') {
    if (isMp4) return 'video/mp4';
    if (bytes.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';
  } else {
    if (isMp4) return 'audio/mp4';
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
    if (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  }
  return null;
}

async function createItem(request: Request, ownerId: string) {
  const id = randomUUID();
  let item: typeof motivationItems.$inferInsert;
  let upload: Buffer | undefined;
  const fileCategory = request.headers.get('X-Motivation-Upload');
  if (fileCategory === 'song' || fileCategory === 'video') {
    let title: string;
    try {
      title = getTitle(decodeURIComponent(request.headers.get('X-Motivation-Title') ?? ''));
    } catch {
      throw new RequestError(400, 'Add a title of up to 100 characters.');
    }
    upload = await readBody(request, maxFileBytes);
    const mediaType = getMediaType(fileCategory, upload);
    if (!mediaType) throw new RequestError(415, fileCategory === 'video' ? 'Choose an MP4 or WebM video.' : 'Choose an MP3, M4A or WAV song.');
    item = { id, ownerId, title, category: fileCategory, kind: 'file', mediaType, byteSize: upload.length };
  } else {
    const bytes = await readBody(request, 8192);
    let input;
    try {
      input = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new RequestError(400, 'Enter valid item details.');
    }
    const title = getTitle(input?.title);
    const category = input?.category;
    const content = typeof input?.content === 'string' ? input.content.trim() : '';
    if (category === 'affirmation' && content.length > 0 && content.length <= 1000) {
      item = { id, ownerId, title, category, kind: 'text', content };
    } else if ((category === 'song' || category === 'video') && content.length <= 2000) {
      let url: URL | undefined;
      try { url = new URL(content); } catch {}
      if (url?.protocol !== 'https:' || url.username || url.password) throw new RequestError(400, 'Enter a valid HTTPS link.');
      item = { id, ownerId, title, category, kind: 'link', content: url.href };
    } else {
      throw new RequestError(400, 'Add affirmation text or choose a song or video.');
    }
  }

  const [saved] = await db().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${ownerId}))`);
    const [usage] = await transaction.select({
      count: sql<number>`count(*)`.mapWith(Number),
      bytes: sql<number>`coalesce(sum(${motivationItems.byteSize}), 0)`.mapWith(Number),
    }).from(motivationItems).where(eq(motivationItems.ownerId, ownerId));
    if (usage.count >= maxItems || usage.bytes + (item.byteSize ?? 0) > maxLibraryBytes) {
      throw new RequestError(409, 'Shelf full. Remove an item before adding more (60 items or 100 MB).');
    }
    const result = await transaction.insert(motivationItems).values(item).returning(publicColumns);
    if (upload) await files().set(id, new Blob([new Uint8Array(upload)]));
    return result;
  });
  return json(saved, 201);
}

function parseRange(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : Math.max(size - Number(match[2]), 0);
  const last = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return first <= last && first < size ? { first, last } : null;
}

function sliceStream(source: ReadableStream<Uint8Array>, first: number, last: number) {
  const reader = source.getReader();
  let position = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return controller.close();
        const start = Math.max(first - position, 0);
        const end = Math.min(last - position + 1, value.length);
        position += value.length;
        if (end > start) controller.enqueue(value.subarray(start, end));
        if (position > last) {
          controller.close();
          void reader.cancel().catch(() => {});
          return;
        }
        if (end > start) return;
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

async function serveMedia(request: Request, item: typeof motivationItems.$inferSelect) {
  if (item.kind !== 'file' || !item.byteSize || !item.mediaType) return json({ error: 'File not found.' }, 404);
  const size = item.byteSize;
  const headers = new Headers({ ...privateHeaders, 'Accept-Ranges': 'bytes', 'Content-Type': item.mediaType });
  const rangeHeader = request.headers.get('Range');
  const range = rangeHeader ? parseRange(rangeHeader, size) : null;
  if (rangeHeader && !range) {
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) headers.set('Content-Range', `bytes ${range.first}-${range.last}/${size}`);
  headers.set('Content-Length', String(range ? range.last - range.first + 1 : size));
  const status = range ? 206 : 200;
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  const stream = await files().get(item.id, { type: 'stream' });
  if (!stream) return json({ error: 'File not found.' }, 404);
  return new Response(range ? sliceStream(stream, range.first, range.last) : stream, { status, headers });
}

export default async function handler(request: Request, context: Context) {
  try {
    const path = new URL(request.url).pathname;
    const match = itemPath.exec(path);
    if (path !== route && !match) return json({ error: 'Not found.' }, 404);
    if (request.method === 'POST' || request.method === 'DELETE') verifyRequestOrigin(request);
    const ownerId = await owner(context);
    if (!ownerId) return json({ error: 'Sign in to open your private shelf.' }, 401);
    if (path === route && request.method === 'GET') {
      const items = await db().select(publicColumns).from(motivationItems)
        .where(eq(motivationItems.ownerId, ownerId)).orderBy(desc(motivationItems.createdAt)).limit(maxItems);
      return json(items);
    }
    if (path === route && request.method === 'POST') return await createItem(request, ownerId);
    if (match && (match[2] ? ['GET', 'HEAD'].includes(request.method) : request.method === 'DELETE')) {
      const ownItem = and(eq(motivationItems.id, match[1]), eq(motivationItems.ownerId, ownerId));
      const [item] = await db().select().from(motivationItems).where(ownItem);
      if (!item) return json({ error: 'Not found.' }, 404);
      if (match[2]) return await serveMedia(request, item);
      if (item.kind === 'file') await files().delete(item.id);
      await db().delete(motivationItems).where(ownItem);
      return new Response(null, { status: 204, headers: privateHeaders });
    }
    return json({ error: 'Method not allowed.' }, 405);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.message }, error.status);
    if (error instanceof Error && 'status' in error && error.status === 403) return json({ error: 'Request must come from this site.' }, 403);
    console.error('Motivation shelf request failed.');
    return json({ error: 'The shelf is unavailable right now. Please try again.' }, 500);
  }
}
