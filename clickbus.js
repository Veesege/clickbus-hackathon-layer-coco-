'use strict';
const pdfParse = require('pdf-parse');

const BASE = 'https://www.bookaway.com/_api/bookings';
const AUTH_URL = 'https://www.bookaway.com/_api/users/auth/login';
const DRY_RUN = process.env.DRY_RUN === 'true';

let cachedToken = null;
let tokenExpiry = null;

async function getAdminToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) return cachedToken;
  console.log('[CB] Logging in to admin API…');
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: 'https://admin.bookaway.com' },
    body: JSON.stringify({ username: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })
  });
  if (!res.ok) throw new Error(`Auth failed ${res.status}`);
  const { access_token } = await res.json();
  cachedToken = access_token;
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23h
  console.log('[CB] Token obtenido');
  return cachedToken;
}

async function makeHeaders() {
  const token = await getAdminToken();
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'bookaway-platform': 'web',
    origin: 'https://admin.bookaway.com'
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isObjectId(s) {
  return typeof s === 'string' && /^[0-9a-f]{24}$/i.test(s);
}

function resolveRoute(b) {
  const i = b.items?.[0];
  const p = i?.product;
  const rawA = p?.stationA?.name || (typeof p?.stationA === 'string' && !isObjectId(p.stationA) ? p.stationA : null);
  const rawB = p?.stationB?.name || (typeof p?.stationB === 'string' && !isObjectId(p.stationB) ? p.stationB : null);
  if (rawA && rawB) return `${rawA} → ${rawB}`;
  const tripFrom = i?.trip?.fromId?.city?.name || i?.trip?.fromId?.address?.split(',').pop()?.trim();
  const tripTo   = i?.trip?.toId?.city?.name   || i?.trip?.toId?.address?.split(',').pop()?.trim();
  if (tripFrom && tripTo && !isObjectId(tripFrom) && !isObjectId(tripTo)) return `${tripFrom} → ${tripTo}`;
  const jOrig = i?.journey?.origin?.name  || i?.journey?.origin;
  const jDest = i?.journey?.destination?.name || i?.journey?.destination;
  if (jOrig && jDest && typeof jOrig === 'string' && typeof jDest === 'string' && !isObjectId(jOrig) && !isObjectId(jDest))
    return `${jOrig} → ${jDest}`;
  if (i?.ecommerce?.name && !isObjectId(i.ecommerce.name)) return i.ecommerce.name;
  const title = b?.title || i?.title || i?.name;
  if (title && !isObjectId(title)) return title;
  const puRaw = i?.pickup?.address || i?.pickup?.name;
  const doRaw = i?.dropOff?.address || i?.dropOff?.name;
  if (puRaw && doRaw) {
    const puCity = String(puRaw).split(',').map(s => s.trim()).filter(Boolean).pop();
    const doCity = String(doRaw).split(',').map(s => s.trim()).filter(Boolean).pop();
    if (puCity && doCity && puCity !== doCity) return `${puCity} → ${doCity}`;
  }
  const slug = p?.denominationSlug || p?.slug;
  if (slug && !isObjectId(slug) && slug.includes('-to-')) return slug;
  return p?.ecommerce?.name || p?.name || '?';
}

function resolveDeparture(b) {
  const i = b.items?.[0];
  const candidates = [
    i?.extrasTravelInformation?.departureDate?.date,
    i?.approvedDeparture?.time,
    i?.journey?.departure?.date,
    i?.journey?.departure,
    i?.trip?.departure?.date,
    i?.trip?.departure,
    i?.departureDate,
    i?.departureDatetime,
    i?.travelDate,
    i?.date,
    i?.datetime,
    b.departureDate,
    b.departureDatetime,
    b.travelDate,
    b.departure?.date,
    b.departure,
    i?.segments?.[0]?.departure?.date,
    i?.segments?.[0]?.departure,
    i?.schedule?.departure?.date,
    i?.schedule?.departure,
  ];
  return candidates.find(v => v && typeof v === 'string' && v.length >= 8) || '?';
}

function normalizeStr(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').trim();
}

function scoreBookingMatch(booking, parsed) {
  let score = 0;
  const raw     = normalizeStr(JSON.stringify(booking));
  const rawOrig = JSON.stringify(booking);

  if (parsed.isoDate && rawOrig.includes(parsed.isoDate)) score += 3;

  if (parsed.fromCity) {
    const keywords = normalizeStr(parsed.fromCity).split(/\s+/).filter(w => w.length > 3);
    if (keywords.some(w => raw.includes(w))) score += 1;
  }

  if (parsed.toCity) {
    const keywords = normalizeStr(parsed.toCity).split(/\s+/).filter(w => w.length > 3);
    if (keywords.some(w => raw.includes(w))) score += 1;
  }

  if (booking.customerStatus === 'pending' && booking.status === 'approved') score += 1;

  return score;
}

// ── Admin API ─────────────────────────────────────────────────────────────────

async function fetchCandidatesByName(first, last) {
  const paramPairs = last
    ? [
        `firstName=${encodeURIComponent(first)}&lastName=${encodeURIComponent(last)}`,
        `first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}`,
      ]
    : [
        `passengerName=${encodeURIComponent(first)}`,
        `search=${encodeURIComponent(first)}`,
      ];

  for (const params of paramPairs) {
    const res = await fetch(`${BASE}/bookings?${params}&limit=50`, { headers: await makeHeaders() });
    if (res.status === 401 || res.status === 403) { cachedToken = null; throw new Error('token_expired — se re-autenticará en el próximo request'); }
    if (!res.ok) continue;
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.data || data.bookings || data.results || [];
    if (list.length > 0) return list;
  }
  return [];
}

async function fetchFullBookingByRef(bwRef) {
  if (!bwRef || bwRef === '?') throw new Error('no ref');
  const res = await fetch(`${BASE}/bookings?references=${bwRef}&limit=1`, { headers: await makeHeaders() });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.data || data.bookings || data.results || [];
  if (!list[0]) throw new Error('empty');
  return list[0];
}

async function findClickbusBooking(parsed) {
  const { firstName, lastName } = parsed;
  const words = `${firstName} ${lastName || ''}`.trim().split(/\s+/).filter(Boolean);

  // Probar splits de más específico a menos específico
  const splits = [];
  for (let i = words.length - 1; i >= 1; i--) {
    splits.push([words.slice(0, i).join(' '), words.slice(i).join(' ')]);
  }
  if (splits.length === 0) splits.push([firstName, null]);

  let candidates = [];
  for (const [fn, ln] of splits) {
    console.log(`[CB] Split: "${fn}" | "${ln || ''}"`);
    const list = await fetchCandidatesByName(fn, ln);
    if (list.length > 0) {
      candidates = list;
      console.log(`[CB] ${list.length} candidatos con split "${fn}" | "${ln || ''}"`);
      break;
    }
  }

  if (candidates.length === 0) return null;

  const pendingApproved = candidates.filter(
    b => b.customerStatus === 'pending' && b.status === 'approved'
  );
  console.log(`[CB] ${candidates.length} candidatos — ${pendingApproved.length} pending+approved`);

  const pool = pendingApproved.length > 0 ? pendingApproved : candidates.slice(0, 10);

  const fullData = (await Promise.all(
    pool.map(b => fetchFullBookingByRef(b.reference).catch(() => b))
  )).filter(Boolean);

  const scored = fullData
    .map(b => ({ booking: b, score: scoreBookingMatch(b, parsed) }))
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;

  const best = scored[0];
  console.log(`[CB] Top: ${best.booking.reference} | score=${best.score}`);

  if (!pendingApproved.length && best.score < 2) {
    console.log(`[CB] No confirmado — score=${best.score} sin pending+approved`);
    return null;
  }

  return { booking: best.booking };
}

// ── PDF parsing ───────────────────────────────────────────────────────────────

function parseClickbusFields(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const t = text.replace(/\s+/g, ' ').trim();

  const tokens = t.split(' ');

  const isNameLabel = (s) => /^(?:NOMBRE|NAME|PASAJERO|PASSENGER)(?:[\/|](?:NOMBRE|NAME|PASAJERO|PASSENGER))?$/i.test(s);
  const isSeatLabel = (s) => /^(?:ASIENTO|SEAT)(?:[\/|](?:ASIENTO|SEAT))?$/i.test(s);
  const isAnyLabel  = (s) => /^(?:ORIGEN|ORIGIN|FROM|DESTINO|DESTINATION|TO|ASIENTO|SEAT|FECHA|DATE|HORA|HOUR|NOMBRE|NAME|PASAJERO|PASSENGER|SERVICIO|SERVICE)(?:[\/|]\w+)?$/i.test(s);
  const isNameLine  = (s) => s && /^[A-ZÁÉÍÓÚÑ\s\-]{2,}$/i.test(s) && !isAnyLabel(s.split(/\s+/)[0]);

  let firstName = null;
  let lastName  = null;

  for (let i = 0; i < lines.length; i++) {
    if (isNameLabel(lines[i].split(/\s+/)[0]) || isNameLabel(lines[i])) {
      let j = i + 1;
      while (j < lines.length && (isAnyLabel(lines[j]) || /^(del?|de|la|los|las|el|pasajero|passenger):?$/i.test(lines[j]))) j++;
      const fLine = (lines[j] || '').trim();
      const lLine = (lines[j + 1] || '').trim();
      if (isNameLine(fLine)) {
        firstName = fLine;
        if (isNameLine(lLine)) lastName = lLine;
        break;
      }
    }
  }

  if (!firstName) {
    const isSkippable = (s) => /^(del?|de|la|los|las|el)$/i.test(s) || s.endsWith(':') || isAnyLabel(s.replace(/:$/, ''));
    for (let i = 0; i < tokens.length; i++) {
      if (isNameLabel(tokens[i])) {
        let j = i + 1;
        while (j < tokens.length && isSkippable(tokens[j])) j++;
        const nameTokens = [];
        let k = j;
        while (k < tokens.length && /^[A-ZÁÉÍÓÚÑ]{2,}$/i.test(tokens[k]) && !isAnyLabel(tokens[k])) {
          nameTokens.push(tokens[k++]);
        }
        if (nameTokens.length >= 2) {
          firstName = nameTokens[0];
          lastName  = nameTokens.slice(1).join(' ');
          break;
        } else if (nameTokens.length === 1) {
          firstName = nameTokens[0];
          break;
        }
      }
    }
  }

  if (!firstName) {
    const m = t.match(/(?:NOMBRE(?:\s+del?\s+PASAJERO)?|NAME|PASAJERO):?\s+([A-ZÁÉÍÓÚÑ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ]{2,})*)/i);
    if (m) {
      const parts = m[1].trim().split(/\s+/);
      firstName = parts[0];
      if (parts.length > 1) lastName = parts.slice(1).join(' ');
    }
  }

  const seats = [];
  for (let i = 0; i < tokens.length; i++) {
    if (isSeatLabel(tokens[i])) {
      const next = tokens[i + 1] || '';
      if (/^\d+$/.test(next) && !seats.includes(next)) seats.push(next);
    }
  }
  if (seats.length === 0) {
    const sm = t.match(/(?:ASIENTO|SEAT)(?:\/\w+)?\s+(\d+)/gi) || [];
    for (const s of sm) {
      const n = s.match(/\d+/)?.[0];
      if (n && !seats.includes(n)) seats.push(n);
    }
  }

  let date = null;
  const dm = t.match(/(?:FECHA|DATE)(?:\/\w+)?\s+(?:[A-Z]{2,3}\s+)?(\d{1,2}\s+[A-Z]{3}\.?\s+\d{2,4})/i)
    || t.match(/\b((?:LUN|MAR|MIE|JUE|VIE|SAB|DOM)\s+\d{1,2}\s+[A-Z]{3}\s+\d{2,4})\b/i);
  if (dm) date = (dm[1] || dm[0]).trim();

  let isoDate = null;
  if (date) {
    const MONTHS = { ENE:'01',FEB:'02',MAR:'03',ABR:'04',MAY:'05',JUN:'06',
                     JUL:'07',AGO:'08',SEP:'09',OCT:'10',NOV:'11',DIC:'12',
                     JAN:'01',AUG:'08',DEC:'12' };
    const md = date.match(/(\d{1,2})\s+([A-Z]{3})\.?\s+(\d{2,4})/i);
    if (md) {
      const day = md[1].padStart(2, '0');
      const mon = MONTHS[md[2].toUpperCase()];
      const yr  = md[3].length === 2 ? '20' + md[3] : md[3];
      if (mon) isoDate = `${yr}-${mon}-${day}`;
    }
  }

  let fromCity = null, toCity = null;
  const isOriginLabel = (s) => /^(?:ORIGEN|ORIGIN|FROM)(?:[\/|]\w+)?$/i.test(s);
  const isDestLabel   = (s) => /^(?:DESTINO|DESTINATION|TO)(?:[\/|]\w+)?$/i.test(s);
  for (let i = 0; i < lines.length; i++) {
    if (isOriginLabel(lines[i]) && !fromCity) {
      const city = (lines[i + 2] || lines[i + 1] || '').split(',')[0].trim();
      if (city) fromCity = city.toLowerCase();
    }
    if (isDestLabel(lines[i]) && !toCity) {
      const city = (lines[i + 2] || lines[i + 1] || '').split(',')[0].trim();
      if (city) toCity = city.toLowerCase();
    }
  }

  console.log('[CB] Parsed:', { firstName, lastName, seats, date, isoDate, fromCity, toCity });
  return { firstName, lastName, seats, date, isoDate, fromCity, toCity };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function processClickbusTicket(pdfBuffer) {
  const pdfData = await pdfParse(pdfBuffer);
  console.log('[CB] PDF text sample:', pdfData.text.slice(0, 300));

  const parsed = parseClickbusFields(pdfData.text);

  if (!parsed.firstName) {
    throw new Error('No se pudo extraer el nombre del pasajero del PDF');
  }

  const found = await findClickbusBooking(parsed);
  if (!found) {
    throw new Error(`No se encontró booking para ${parsed.firstName} ${parsed.lastName || ''}`);
  }

  const { booking } = found;
  const paxCount = booking.passengers?.length
    || booking.items?.[0]?.passengers?.length
    || parsed.seats.length
    || 1;

  return {
    bwRef:         booking.reference,
    bookingId:     booking._id,
    passengerName: `${parsed.firstName} ${parsed.lastName || ''}`.trim(),
    route:         resolveRoute(booking),
    date:          resolveDeparture(booking) !== '?' ? resolveDeparture(booking) : (parsed.date || '?'),
    seats:         parsed.seats,
    passengers:    paxCount
  };
}

async function approveClickbusBooking(bookingId, bwRef, seats, passengers, pdfBuffer) {
  if (DRY_RUN) {
    console.log(`[CB] [DRY_RUN] Aprobaría booking ${bwRef} — no ejecutado`);
    return { success: true, bwRef, dry: true };
  }

  const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
  const formData = new FormData();
  formData.append('owner', bookingId);
  formData.append('bookingReference', bwRef);
  formData.append('types', 'attachment');
  formData.append('files', blob, `${bwRef}.pdf`);

  const uploadHeaders = await makeHeaders();
  delete uploadHeaders.Accept; // FormData no necesita Accept
  console.log(`[CB] Subiendo PDF para ${bwRef}…`);
  const uploadRes = await fetch('https://www.bookaway.com/_api/images/upload/files', {
    method: 'POST',
    headers: uploadHeaders,
    body: formData
  });

  if (!uploadRes.ok) {
    const t = await uploadRes.text().catch(() => '');
    throw new Error(`Upload failed ${uploadRes.status}: ${t.slice(0, 150)}`);
  }

  const uploadData = await uploadRes.json();
  const attachment = Array.isArray(uploadData) ? uploadData[0] : uploadData;
  if (!attachment?.id && attachment?._id) attachment.id = attachment._id;
  if (!attachment?.id) throw new Error('Upload no devolvió ID del archivo');

  const approvePayload = {
    extras: [],
    pickups:  [{ time: 0, location: null }],
    dropOffs: [null],
    voucherAttachments: [{
      id:   attachment.id,
      url:  attachment.url || `${attachment.id}.pdf`,
      name: `${bwRef}.pdf`,
      ...(attachment.thumbnailUrl ? { thumbnailUrl: attachment.thumbnailUrl } : {})
    }],
    approvalInputs: {
      bookingCode: (seats || []).join(' '),
      departureTrip: {
        seatsNumber: seats || [],
        ticketsQrCode: []
      },
      returnTrip: {
        seatsNumber: [],
        ticketsQrCode: []
      }
    }
  };

  console.log(`[CB] Aprobando booking ${bwRef}…`);
  const approveRes = await fetch(`${BASE}/v2/bookings/${bookingId}/approve`, {
    method: 'POST',
    headers: { ...(await makeHeaders()), 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify(approvePayload)
  });

  if (!approveRes.ok) {
    const t = await approveRes.text().catch(() => '');
    throw new Error(`Approve failed ${approveRes.status}: ${t.slice(0, 200)}`);
  }

  console.log(`[CB] Booking ${bwRef} aprobada`);
  return { success: true, bwRef, dry: false };
}

module.exports = { processClickbusTicket, approveClickbusBooking, DRY_RUN };
