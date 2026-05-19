'use strict';
require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const { processClickbusTicket, approveClickbusBooking, DRY_RUN } = require('./clickbus');

const app = express();
app.use(express.json());

// ── Auth middleware ───────────────────────────────────────────────────────────

const DASHBOARD_USER = process.env.DASHBOARD_USER;
const DASHBOARD_PASS = process.env.DASHBOARD_PASS;
const SESSION_SECRET = process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');
const SESSION_COOKIE = 'coco_session';

function signSession(user) {
  const crypto = require('crypto');
  const payload = `${user}:${Date.now()}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`).toString('base64');
}

function verifySession(token) {
  try {
    const crypto = require('crypto');
    const decoded = Buffer.from(token, 'base64').toString();
    const lastPipe = decoded.lastIndexOf('|');
    const payload = decoded.slice(0, lastPipe);
    const sig = decoded.slice(lastPipe + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    return sig === expected;
  } catch { return false; }
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').map(c => c.trim().split('=').map(decodeURIComponent))
  );
}

function requireAuth(req, res, next) {
  if (!DASHBOARD_USER || !DASHBOARD_PASS) return next();
  if (req.path === '/login') return next();
  if (req.path === '/api/clickbus/trigger') return next(); // webhook de Zendesk, sin session
  const cookies = parseCookies(req);
  if (cookies[SESSION_COOKIE] && verifySession(cookies[SESSION_COOKIE])) return next();
  res.redirect('/login');
}

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/login', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Clickbus Agent — Login</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',sans-serif;background:#1a1a1a;color:#ececec;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .box{background:#222;border:1px solid #2e2e2e;border-radius:10px;padding:36px 32px;width:100%;max-width:340px}
    h1{font-size:16px;font-weight:600;margin-bottom:24px;color:#e0e0e0}
    label{font-size:12px;color:#888;display:block;margin-bottom:6px}
    input{width:100%;padding:9px 12px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#ececec;font-size:14px;margin-bottom:16px;outline:none}
    input:focus{border-color:#555}
    button{width:100%;padding:10px;background:#1e3a5f;color:#60a5fa;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer}
    button:hover{background:#1a3356}
    .err{color:#ef4444;font-size:12px;margin-bottom:14px}
  </style>
</head>
<body>
  <div class="box">
    <h1>🚌 Clickbus Agent</h1>
    ${req.query.error ? '<p class="err">Usuario o contraseña incorrectos.</p>' : ''}
    <form method="POST" action="/login">
      <label>Usuario</label>
      <input name="user" type="text" autocomplete="username" autofocus>
      <label>Contraseña</label>
      <input name="pass" type="password" autocomplete="current-password">
      <button type="submit">Entrar</button>
    </form>
  </div>
</body>
</html>`);
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const { user, pass } = req.body;
  if (user === DASHBOARD_USER && pass === DASHBOARD_PASS) {
    const token = signSession(user);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`);
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

// ── Zendesk helpers ───────────────────────────────────────────────────────────

const ZENDESK_BASE = `https://${process.env.ZENDESK_SUBDOMAIN || 'bookaway'}.zendesk.com`;
const ZENDESK_AUTH = Buffer.from(
  `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_TOKEN}`
).toString('base64');
const ZENDESK_REFERENCE_FIELD_ID = process.env.ZENDESK_REFERENCE_FIELD_ID
  ? +process.env.ZENDESK_REFERENCE_FIELD_ID
  : null;

function fetchWithTimeout(url, opts = {}, ms = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(timer));
}

async function getTicketPDF(ticketId) {
  const res = await fetchWithTimeout(
    `${ZENDESK_BASE}/api/v2/tickets/${ticketId}/comments.json?per_page=25`,
    { headers: { Authorization: `Basic ${ZENDESK_AUTH}` } }
  );
  if (!res.ok) throw new Error(`Zendesk comments ${res.status}`);
  const { comments } = await res.json();
  for (const comment of comments || []) {
    const pdf = (comment.attachments || []).find(a => a.content_type === 'application/pdf');
    if (pdf) {
      const dlRes = await fetchWithTimeout(pdf.content_url, {
        headers: { Authorization: `Basic ${ZENDESK_AUTH}` }
      });
      if (!dlRes.ok) throw new Error(`PDF download ${dlRes.status}`);
      const buffer = Buffer.from(await dlRes.arrayBuffer());
      return { buffer, url: pdf.content_url, filename: pdf.file_name };
    }
  }
  return null;
}

async function updateZendeskTicket(ticketId, bwRef, passengerName, tripLabel = null) {
  const refLine = tripLabel ? `${bwRef} ${tripLabel}` : bwRef;
  const body = {
    ticket: {
      status: 'solved',
      comment: {
        body: `✅ Automatically approved by Clickbus Agent.\n${refLine} — ${passengerName}`,
        public: false
      }
    }
  };
  if (ZENDESK_REFERENCE_FIELD_ID && bwRef) {
    body.ticket.custom_fields = [{ id: ZENDESK_REFERENCE_FIELD_ID, value: refLine }];
  }
  const res = await fetchWithTimeout(`${ZENDESK_BASE}/api/v2/tickets/${ticketId}.json`, {
    method: 'PUT',
    headers: {
      Authorization: `Basic ${ZENDESK_AUTH}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Zendesk update ${res.status}: ${t.slice(0, 100)}`);
  }
}

// ── Fase 1: parsear PDF + buscar booking ──────────────────────────────────────

async function processTicketForReview(ticketId) {
  const logId = db.log('clickbus', `Ticket #${ticketId} — processing…`, { ticketId }, null, ['clickbus']);
  let parsedInfo = null;

  try {
    const pdfResult = await getTicketPDF(ticketId);
    if (!pdfResult) {
      db.updateLog(logId, 'pending', `Ticket #${ticketId} — no PDF attachment`, { ticketId }, 'no_pdf_attachment');
      return;
    }

    const info = await processClickbusTicket(pdfResult.buffer);
    parsedInfo = { ...info, ticketId, pdfUrl: pdfResult.url };

    if (info.isRoundTrip) {
      const companion = db.findPendingByBwRef(info.bwRef);

      if (companion) {
        const firstLeg          = companion.data.leg || 'departure';
        const departurePdfUrl   = firstLeg === 'departure' ? companion.data.pdfUrl : pdfResult.url;
        const returnPdfUrl      = firstLeg === 'return'    ? companion.data.pdfUrl : pdfResult.url;
        const departureSeats    = firstLeg === 'departure' ? companion.data.seats  : info.seats;
        const returnSeats       = firstLeg === 'return'    ? companion.data.seats  : info.seats;
        const departureTicketId = firstLeg === 'departure' ? companion.data.ticketId : ticketId;
        const returnTicketId    = firstLeg === 'return'    ? companion.data.ticketId : ticketId;

        const companionDl = await fetchWithTimeout(companion.data.pdfUrl, { headers: { Authorization: `Basic ${ZENDESK_AUTH}` } });
        if (!companionDl.ok) throw new Error(`Companion PDF download ${companionDl.status}`);
        const companionBuffer = Buffer.from(await companionDl.arrayBuffer());
        const depBuffer = firstLeg === 'departure' ? companionBuffer : pdfResult.buffer;
        const retBuffer = firstLeg === 'return'    ? companionBuffer : pdfResult.buffer;

        const mergedData = {
          bwRef: info.bwRef, bookingId: info.bookingId, passengerName: info.passengerName,
          route: info.route, date: info.date, passengers: info.passengers,
          roundTrip: true, departurePdfUrl, returnPdfUrl,
          departureSeats, returnSeats, departureTicketId, returnTicketId
        };

        await approveClickbusBooking(info.bookingId, info.bwRef, departureSeats, info.passengers, depBuffer, {
          returnSeats, returnPdfBuffer: retBuffer
        });

        if (departureTicketId) await updateZendeskTicket(departureTicketId, info.bwRef, info.passengerName, 'Outbound trip');
        if (returnTicketId)    await updateZendeskTicket(returnTicketId,    info.bwRef, info.passengerName, 'Return trip');

        const summary = `${DRY_RUN ? '[DRY] ' : ''}✅ ${info.bwRef} — ${info.passengerName} — Round Trip — approved`;
        db.updateLog(companion.id, 'pending', summary, { ...mergedData, dry: DRY_RUN }, null);
        db.markDismissed(logId);
        console.log(`[CB] Round Trip auto-approved: ${summary}`);

      } else {
        db.updateLog(logId, 'pending',
          `⏳ ${info.bwRef} — ${info.passengerName} — Waiting for companion leg`,
          { ...info, ticketId, pdfUrl: pdfResult.url, waitingCompanion: true },
          null
        );
        console.log(`[CB] Round Trip first leg: ${info.bwRef} — ${info.leg} — waiting for companion`);
      }

    } else {
      await approveClickbusBooking(info.bookingId, info.bwRef, info.seats, info.passengers, pdfResult.buffer);
      if (ticketId) await updateZendeskTicket(ticketId, info.bwRef, info.passengerName);

      const summary = `${DRY_RUN ? '[DRY] ' : ''}✅ ${info.bwRef} — ${info.passengerName} — Ticket #${ticketId} — approved`;
      db.updateLog(logId, 'pending', summary, { ...info, ticketId, pdfUrl: pdfResult.url, dry: DRY_RUN }, null);
      console.log(`[CB] Auto-approved: ${summary}`);
    }

  } catch (err) {
    console.error(`[CB] Ticket #${ticketId} error:`, err.message);
    db.updateLog(logId, 'pending', `Ticket #${ticketId} — ${err.message}`, parsedInfo || { ticketId }, err.message);
    fetchWithTimeout(`${ZENDESK_BASE}/api/v2/tickets/${ticketId}.json`, {
      method: 'PUT',
      headers: { Authorization: `Basic ${ZENDESK_AUTH}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticket: { comment: { body: `⚠️ Clickbus Agent: ${err.message}. Manual review required.`, public: false } }
      })
    }).catch(e => console.warn('[CB] Zendesk error comment failed:', e.message));
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Webhook Zendesk → { "ticket_id": "{{ticket.id}}" }
app.post('/api/clickbus/trigger', (req, res) => {
  const { ticket_id } = req.body;
  if (!ticket_id || !/^\d+$/.test(String(ticket_id))) {
    return res.status(400).json({ error: 'invalid ticket_id' });
  }
  res.json({ ok: true });
  processTicketForReview(String(ticket_id)).catch(console.error);
});

// Fase 2: aprobación manual — atomic claim antes de ejecutar
app.post('/api/clickbus/approve/:logId', async (req, res) => {
  const id = +req.params.logId;
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });

  const logEntry = db.getLog(id);
  if (!logEntry || !logEntry.data) {
    console.warn(`[CB] Approve #${id}: log not found`);
    return res.status(404).json({ error: 'log not found' });
  }
  if (logEntry.status === 'reviewed') {
    console.warn(`[CB] Approve #${id}: ya estaba reviewed`);
    return res.status(409).json({ error: 'already approved' });
  }
  if (logEntry.status === 'approving') {
    console.warn(`[CB] Approve #${id}: atascado en approving — reseteando a pending`);
    db.updateLog(id, 'pending', logEntry.summary, logEntry.data, logEntry.error);
    return res.status(409).json({ error: 'was stuck in approving — reset to pending, retry' });
  }

  // Atomic claim: only one request wins this UPDATE
  const claimed = db.claimForApproval(id);
  if (!claimed) {
    console.warn(`[CB] Approve #${id}: claim fallido (race condition)`);
    return res.status(409).json({ error: 'already in progress' });
  }

  const { bookingId, bwRef, passengers, passengerName } = logEntry.data;
  const isRoundTrip = !!logEntry.data.roundTrip && !logEntry.data.waitingCompanion;

  try {
    let summary;

    if (isRoundTrip) {
      const { departurePdfUrl, returnPdfUrl, departureSeats, returnSeats, departureTicketId, returnTicketId } = logEntry.data;

      const depDl = await fetchWithTimeout(departurePdfUrl, { headers: { Authorization: `Basic ${ZENDESK_AUTH}` } });
      if (!depDl.ok) throw new Error(`Departure PDF re-download ${depDl.status}`);
      const depBuffer = Buffer.from(await depDl.arrayBuffer());

      const retDl = await fetchWithTimeout(returnPdfUrl, { headers: { Authorization: `Basic ${ZENDESK_AUTH}` } });
      if (!retDl.ok) throw new Error(`Return PDF re-download ${retDl.status}`);
      const retBuffer = Buffer.from(await retDl.arrayBuffer());

      await approveClickbusBooking(bookingId, bwRef, departureSeats, passengers, depBuffer, {
        returnSeats, returnPdfBuffer: retBuffer
      });

      if (departureTicketId) await updateZendeskTicket(departureTicketId, bwRef, passengerName, 'Outbound trip');
      if (returnTicketId)    await updateZendeskTicket(returnTicketId, bwRef, passengerName, 'Return trip');

      summary = `${DRY_RUN ? '[DRY] ' : ''}✅ ${bwRef} — ${passengerName} — Round Trip — approved`;

    } else {
      const { seats, pdfUrl, ticketId } = logEntry.data;

      const dlRes = await fetchWithTimeout(pdfUrl, { headers: { Authorization: `Basic ${ZENDESK_AUTH}` } });
      if (!dlRes.ok) throw new Error(`PDF re-download ${dlRes.status}`);
      const buffer = Buffer.from(await dlRes.arrayBuffer());

      await approveClickbusBooking(bookingId, bwRef, seats, passengers, buffer);

      if (ticketId) await updateZendeskTicket(ticketId, bwRef, passengerName);

      summary = `${DRY_RUN ? '[DRY] ' : ''}✅ ${bwRef} — ${passengerName} — Ticket #${ticketId} — approved`;
    }

    db.updateLog(id, 'reviewed', summary, { ...logEntry.data, dry: DRY_RUN }, null);
    console.log(`[CB] Aprobado manualmente: ${summary}`);

    res.json({ ok: true, bwRef, summary });

  } catch (err) {
    console.error('[CB] Approve error:', err.message);
    db.updateLog(id, 'pending',
      `❌ Error aprobando ${bwRef}: ${err.message}`,
      logEntry.data,
      err.message
    );
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs', (req, res) => {
  const { status, type, tag, error_only, limit = 200 } = req.query;
  const logs = db.getLogs({ status, type, tag, limit: +limit, errorOnly: error_only === '1' });
  const pending = db.countPending();
  res.json({ logs, pending });
});

app.post('/api/logs/:id/review', (req, res) => {
  const id = +req.params.id;
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  db.markReviewed(id);
  res.json({ ok: true });
});

app.post('/api/logs/:id/dismiss', (req, res) => {
  const id = +req.params.id;
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  db.markDismissed(id);
  res.json({ ok: true });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'logs.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Clickbus Agent ${DRY_RUN ? '[DRY_RUN] ' : ''}running on :${PORT}`);
  console.log(`Auth: ${DASHBOARD_USER ? `enabled (user: ${DASHBOARD_USER})` : 'DISABLED — set DASHBOARD_USER and DASHBOARD_PASS in .env'}`);
});
