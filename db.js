'use strict';
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.NODE_ENV === 'production'
  ? '/data/logs.db'
  : path.join(__dirname, 'logs.db');

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT    NOT NULL,
    type      TEXT    NOT NULL,
    status    TEXT    NOT NULL DEFAULT 'pending',
    summary   TEXT    NOT NULL,
    data      TEXT,
    error     TEXT,
    tags      TEXT,
    notes     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_status ON logs(status);
  CREATE INDEX IF NOT EXISTS idx_type   ON logs(type);
  CREATE INDEX IF NOT EXISTS idx_ts     ON logs(timestamp);
`);

const insertLog = db.prepare(`
  INSERT INTO logs (timestamp, type, status, summary, data, error, tags)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const updateLogStmt = db.prepare(`
  UPDATE logs SET status = ?, summary = ?, data = ?, error = ? WHERE id = ?
`);

function log(type, summary, data = null, error = null, tags = null) {
  return insertLog.run(
    new Date().toISOString(),
    type,
    'pending',
    summary,
    data  ? JSON.stringify(data) : null,
    error || null,
    tags  ? JSON.stringify(tags) : null
  ).lastInsertRowid;
}

function updateLog(id, status, summary, data = null, error = null) {
  return updateLogStmt.run(
    status,
    summary,
    data  ? JSON.stringify(data) : null,
    error || null,
    id
  ).changes;
}

function getLog(id) {
  const r = db.prepare('SELECT * FROM logs WHERE id = ?').get(id);
  if (!r) return null;
  return { ...r, data: r.data ? JSON.parse(r.data) : null, tags: r.tags ? JSON.parse(r.tags) : [] };
}

function getLogs({ status, type, tag, limit = 100, offset = 0, errorOnly = false } = {}) {
  let q = 'SELECT * FROM logs';
  const params = [];
  const where = [];
  if (status)    { where.push('status = ?');        params.push(status); }
  if (type)      { where.push('type = ?');          params.push(type); }
  if (errorOnly) { where.push('error IS NOT NULL'); }
  if (tag)       { where.push("tags LIKE ?");       params.push(`%"${tag}"%`); }
  if (where.length) q += ' WHERE ' + where.join(' AND ');
  q += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(q).all(...params).map(r => ({
    ...r,
    data: r.data ? JSON.parse(r.data) : null,
    tags: r.tags ? JSON.parse(r.tags) : []
  }));
}

function getTagCounts(status) {
  const where = status ? `WHERE status = '${status}' AND tags IS NOT NULL` : 'WHERE tags IS NOT NULL';
  return db.prepare(`SELECT tags FROM logs ${where}`).all()
    .flatMap(r => { try { return JSON.parse(r.tags); } catch { return []; } })
    .reduce((acc, t) => { acc[t] = (acc[t] || 0) + 1; return acc; }, {});
}

function markReviewed(id) {
  return db.prepare("UPDATE logs SET status = 'reviewed' WHERE id = ?").run(id).changes;
}

function countPending() {
  return db.prepare("SELECT COUNT(*) as n FROM logs WHERE status = 'pending'").get().n;
}

function saveNote(id, notes) {
  return db.prepare("UPDATE logs SET notes = ? WHERE id = ?").run(notes, id).changes;
}

module.exports = { log, updateLog, getLog, getLogs, markReviewed, countPending, getTagCounts, saveNote };
