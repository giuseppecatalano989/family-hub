import express from 'express';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { UPLOAD_SCHEMA } from './schema.mjs';

const CHUNK = 2 * 1024 * 1024;
export function installChunkUploads(app, { db, atomic, owned, fail, dataDir }) {
  if (!db.cloud) db.exec(UPLOAD_SCHEMA);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  async function upload(req) {
    await owned('notes', req.params.id, req.user);
    const record = await one('SELECT * FROM file_uploads WHERE id = ? AND note_id = ? AND user_id = ? AND expires > ?', req.params.uploadId, req.params.id, req.user.id, Date.now());
    if (!record) fail('Caricamento non trovato o scaduto. Seleziona di nuovo il file.', 404);
    return record;
  }
  app.post('/api/notes/:id/uploads', async (req, res) => {
    await atomic(async () => {
      await owned('notes', req.params.id, req.user);
      if ((await one('SELECT COUNT(*) AS count FROM attachments WHERE note_id = ?', req.params.id)).count >= 5) fail('Puoi aggiungere al massimo 5 file a un appunto.');
      const { name, size, mime = 'application/octet-stream' } = req.body;
      if (typeof name !== 'string' || !name.trim() || name.length > 255 || !Number.isSafeInteger(size) || size < 0 || size > 10 * 1024 * 1024 || typeof mime !== 'string' || mime.length > 200) fail('File non valido. Il limite è 10 MB per file.');
      await run('DELETE FROM file_uploads WHERE expires <= ? OR user_id = ?', Date.now(), req.user.id);
      const id = randomUUID();
      const safeName = path.basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'allegato';
      await run('INSERT INTO file_uploads VALUES (?, ?, ?, ?, ?, ?, ?)', id, req.params.id, req.user.id, safeName, mime, size, Date.now() + 3600_000);
      res.status(201).json({ id });
    });
  });
  app.put('/api/notes/:id/uploads/:uploadId/chunks/:index', express.raw({ type: 'application/octet-stream', limit: CHUNK }), async (req, res) => {
    await atomic(async () => {
      const record = await upload(req);
      const index = Number(req.params.index);
      const count = Math.max(1, Math.ceil(record.size / CHUNK));
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const expected = index === count - 1 ? record.size - index * CHUNK : CHUNK;
      if (!Number.isInteger(index) || index < 0 || index >= count || bytes.length !== expected) fail('Parte del file non valida.');
      const prior = await one('SELECT data FROM file_upload_chunks WHERE upload_id = ? AND chunk_index = ?', record.id, index);
      if (prior) {
        if (!Buffer.from(prior.data).equals(bytes)) fail('Parte del file già caricata con un contenuto diverso.', 409);
        return res.json({ ok: true });
      }
      if (db.cloud) {
        const { used } = await one('SELECT (COALESCE((SELECT SUM(octet_length(data)) FROM files), 0) + COALESCE((SELECT SUM(octet_length(data)) FROM file_upload_chunks), 0))::bigint AS used');
        if (used + bytes.length > 40 * 1024 * 1024) fail('Spazio allegati esaurito (40 MB totali). Rimuovi i file che non servono.', 413);
      }
      await run('INSERT INTO file_upload_chunks VALUES (?, ?, ?)', record.id, index, bytes);
      res.json({ ok: true });
    });
  });
  app.post('/api/notes/:id/uploads/:uploadId/complete', async (req, res) => {
    const file = path.join(dataDir, 'uploads', req.params.uploadId);
    let written = false;
    try {
      await atomic(async () => {
        await owned('notes', req.params.id, req.user);
        const existing = await one('SELECT id FROM attachments WHERE id = ? AND note_id = ?', req.params.uploadId, req.params.id);
        if (existing) return res.status(201).json({ id: existing.id });
        const record = await upload(req);
        if ((await one('SELECT COUNT(*) AS count FROM attachments WHERE note_id = ?', req.params.id)).count >= 5) fail('Puoi aggiungere al massimo 5 file a un appunto.');
        const chunks = await all('SELECT chunk_index, data FROM file_upload_chunks WHERE upload_id = ? ORDER BY chunk_index', record.id);
        if (chunks.length !== Math.max(1, Math.ceil(record.size / CHUNK)) || chunks.some((c, i) => c.chunk_index !== i)) fail('Il caricamento è incompleto.');
        const bytes = Buffer.concat(chunks.map(c => Buffer.from(c.data)));
        if (bytes.length !== record.size) fail('Il caricamento è incompleto.');
        if (db.cloud) await db.files.put(record.id, bytes);
        else { writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' }); written = true; }
        await run('INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?)', record.id, req.params.id, record.name, record.id, record.mime, record.size);
        await run('DELETE FROM file_uploads WHERE id = ?', record.id);
        res.status(201).json({ id: record.id });
      });
    } catch (error) { if (written) await unlink(file); throw error; }
  });
}
