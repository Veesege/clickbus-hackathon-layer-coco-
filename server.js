'use strict';
const express = require('express');
const path = require('path');
const db = require('./db');
const { processClickbusTicket, approveClickbusBooking, DRY_RUN } = require('./clickbus');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ZENDESK_BASE = `https://${process.env.ZENDESK_SUBDOMAIN || 'bookaway'}.zendesk.com`;
const ZENDESK_AUTH = Buffer.from(
  `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_TOKEN}`
).toString('base64');
const ZENDESK_REFERENCE_FIELD_ID = process.env.ZENDESK_REFERENCE_FIELD_ID
  ? +process.env.ZENDESK_REFERENCE_FIELD_ID
  : null;

async function getTicketPDF(ticketId) {
  const res = await fetch(
    `${ZENDESK_BASE}/api/v2/tickets/${ticketId}/comments.json?per_page=25`,
    { headers: { Authorization: `Basic ${ZENDESK_AUTH}` } }
  );
  if (!res.ok) throw new Error(`Zendesk comments ${res.status}`);
  const { comments } = await res.json();
  for (const comment of comments || []) {
    const pdf = (comment.attachments || []).find(a => a.content_type === 'application/pdf');
    if (pdf) {
      const dlRes = await fetch(pdf.content_url, {
        headers: { Authorization: `Basic ${ZENDESK_AUTH}` }
      });
      if (!dlRes.ok) throw new Error(`PDF download ${dlRes.status}`);
      const buffer = Buffer.from(await dlRes.arrayBuffer());
      return { buffer, filename: pdf.file_name };
    }
  }
  return null;
}

async function updateZendeskTicket(ticketId, bwRef, passengerName) {
  const body = {
    ticket: {
      status: 'solved',
      comment: {
        body: `✅ Aprobado automáticamente por Clickbus Agent.\nBW: ${bwRef} — ${passengerName}`,
        public: false
      }
    }
  };
  if (ZENDESK_REFERENCE_FIELD_ID && bwRef) {
    body.ticket.custom_fields = [{ id: ZENDESK_REFERENCE_FIELD_ID, value: bwRef }];
  }
  const res = await fetch(`${ZENDESK_BASE}/api/v2/tickets/${ticketId}.json`, {
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

async function processAndApproveTicket(ticketId) {
  const logId = db.log(
    'clickbus',
    `Ticket #${ticketId} — procesando…`,
    { ticketId },
    null,
    ['clickbus']
  );

  try {
    const pdfResult = await getTicketPDF(ticketId);
    if (!pdfResult) {
      db.updateLog(logId, 'pending', `Ticket #${ticketId} — sin PDF adjunto`, null, 'no_pdf_attachment');
      return;
    }

    const info = await processClickbusTicket(pdfResult.buffer);

    await approveClickbusBooking(info.bookingId, info.bwRef, info.seats, info.passengers, pdfResult.buffer);

    if (!DRY_RUN) {
      await updateZendeskTicket(ticketId, info.bwRef, info.passengerName);
    }

    const summary = `${DRY_RUN ? '[DRY] ' : ''}✅ ${info.bwRef} — ${info.passengerName} — Ticket #${ticketId}`;
    db.updateLog(logId, 'reviewed', summary, { ...info, dry: DRY_RUN }, null);
    console.log(`[CB] ${summary}`);

  } catch (err) {
    console.error(`[CB] Ticket #${ticketId} error:`, err.message);
    db.updateLog(logId, 'pending', `Ticket #${ticketId} — ${err.message}`, null, err.message);
  }
}

// Webhook Zendesk → { "ticket_id": "{{ticket.id}}" }
app.post('/api/clickbus/trigger', (req, res) => {
  const { ticket_id } = req.body;
  res.json({ ok: true });
  if (ticket_id) processAndApproveTicket(String(ticket_id)).catch(console.error);
});

app.get('/api/logs', (req, res) => {
  const { status, type, tag, error_only, limit = 200 } = req.query;
  const logs = db.getLogs({ status, type, tag, limit: +limit, errorOnly: error_only === '1' });
  const pending = db.countPending();
  const tagCounts = db.getTagCounts(status === 'pending' ? 'pending' : null);
  res.json({ logs, pending, tagCounts });
});

app.post('/api/logs/:id/review', (req, res) => {
  db.markReviewed(+req.params.id);
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'logs.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Clickbus Agent ${DRY_RUN ? '[DRY_RUN] ' : ''}running on :${PORT}`)
);
