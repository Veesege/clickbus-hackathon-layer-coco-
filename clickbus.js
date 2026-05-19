'use strict';
const pdfParse = require('pdf-parse');

const BASE = 'https://www.bookaway.com/_api/bookings';
const AUTH_URL = 'https://www.bookaway.com/_api/users/auth/login';
const DRY_RUN = process.env.DRY_RUN === 'true';

// ── Claude Haiku PDF parser ───────────────────────────────────────────────────

async function parseWithClaude(text) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: `Extract fields from this bus ticket. Return ONLY a single valid JSON object. No explanation, no markdown, no trailing commas.

Fields:
- firstName: string
- lastName: string or null
- seats: array of seat number strings e.g. ["7","8"], empty array if none
- date: date string as written or null
- isoDate: YYYY-MM-DD or null
- fromCity: origin city name lowercase or null (just the city, not the station)
- toCity: destination city name lowercase or null (just the city, not the station)

Ticket:
${text.slice(0, 2000)}`
        }]
      })
    });

    if (!res.ok) return null;
    const data = await res.json();
    const raw = data.content?.[0]?.text?.trim();
    if (!raw) return null;

    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) { console.warn('[CB] Haiku: no JSON found in response'); return null; }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn('[CB] Haiku JSON parse error:', e.message, '| raw:', raw.slice(0, 200));
      return null;
    }
    if (!parsed.firstName || typeof parsed.firstName !== 'string') return null;

    console.log('[CB] Haiku parsed:', parsed);
    return {
      firstName: parsed.firstName,
      lastName:  parsed.lastName  || null,
      seats:     Array.isArray(parsed.seats) ? parsed.seats.map(String) : [],
      date:      parsed.date      || null,
      isoDate:   parsed.isoDate   || null,
      fromCity:  parsed.fromCity  || null,
      toCity:    parsed.toCity    || null,
    };
  } catch (err) {
    console.warn('[CB] Haiku parse failed:', err.message);
    return null;
  }
}

let cachedToken = null;
let tokenExpiry = null;

function fetchWithTimeout(url, opts = {}, ms = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(timer));
}

async function getAdminToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) return cachedToken;
  console.log('[CB] Logging in to admin API…');
  const res = await fetchWithTimeout(AUTH_URL, {
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

function invalidateToken() {
  cachedToken = null;
  tokenExpiry = null;
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
  const fallback = p?.ecommerce?.name || p?.name;
  if (!fallback) console.warn(`[CB] resolveRoute: no route resolved for booking ${b.reference || b._id}`);
  return fallback || '?';
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
    const res = await fetchWithTimeout(`${BASE}/bookings?${params}&limit=50`, { headers: await makeHeaders() });
    if (res.status === 401 || res.status === 403) {
      invalidateToken();
      throw new Error('token_expired — se re-autenticará en el próximo request');
    }
    if (!res.ok) continue;
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.data || data.bookings || data.results || [];
    if (list.length > 0) return list;
  }
  return [];
}

async function fetchFullBookingByRef(bwRef) {
  if (!bwRef || bwRef === '?') throw new Error('no ref');
  const res = await fetchWithTimeout(`${BASE}/bookings?references=${bwRef}&limit=1`, { headers: await makeHeaders() });
  if (res.status === 401 || res.status === 403) {
    invalidateToken();
    throw new Error('token_expired en fetchFullBookingByRef');
  }
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

  const pool = pendingApproved.length > 0 ? pendingApproved : candidates.slice(0, 5);

  // Fetch full data; drop failed fetches instead of using partial objects
  const fullResults = await Promise.allSettled(pool.map(b => fetchFullBookingByRef(b.reference)));
  const fullData = fullResults
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  if (fullData.length === 0) return null;

  const scored = fullData
    .map(b => ({ booking: b, score: scoreBookingMatch(b, parsed) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  console.log(`[CB] Top: ${best.booking.reference} | score=${best.score}`);

  // Always require at least score=1 regardless of pending+approved status
  if (best.score < 1) {
    console.log(`[CB] No confirmado — score=${best.score} insuficiente`);
    return null;
  }

  return { booking: best.booking };
}

// ── PDF parsing ───────────────────────────────────────────────────────────────

// ── Round trip helpers ────────────────────────────────────────────────────────

function resolveIsRoundTrip(booking) {
  return (booking.items?.length || 0) > 1;
}

function resolveLeg(booking, parsedFromCity) {
  if (!parsedFromCity) return 'departure';
  const depCity = (booking.items?.[0]?.trip?.fromId?.city?.name || '').toLowerCase();
  const depWords = depCity.split(/\s+/).filter(w => w.length > 3);
  const matchesDep = depWords.some(w => parsedFromCity.includes(w));
  return matchesDep ? 'departure' : 'return';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function processClickbusTicket(pdfBuffer) {
  const pdfData = await pdfParse(pdfBuffer);
  console.log('[CB] PDF text sample:', pdfData.text.slice(0, 300));

  const parsed = await parseWithClaude(pdfData.text);
  if (!parsed?.firstName) {
    throw new Error('Could not extract passenger name from PDF');
  }

  const found = await findClickbusBooking(parsed);
  if (!found) {
    throw new Error(`No booking found for ${parsed.firstName} ${parsed.lastName || ''}`);
  }

  const { booking } = found;
  const paxCount = booking.passengers?.length
    || booking.items?.[0]?.passengers?.length
    || parsed.seats.length
    || 1;

  const isRoundTrip = resolveIsRoundTrip(booking);
  const leg = isRoundTrip ? resolveLeg(booking, parsed.fromCity) : null;

  return {
    bwRef:         booking.reference,
    bookingId:     booking._id,
    passengerName: `${parsed.firstName} ${parsed.lastName || ''}`.trim(),
    route:         resolveRoute(booking),
    date:          resolveDeparture(booking) !== '?' ? resolveDeparture(booking) : (parsed.date || '?'),
    seats:         parsed.seats,
    passengers:    paxCount,
    isRoundTrip,
    leg
  };
}

async function uploadPdf(bookingId, bwRef, pdfBuffer, suffix = '') {
  const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
  const formData = new FormData();
  formData.append('owner', bookingId);
  formData.append('bookingReference', bwRef);
  formData.append('types', 'attachment');
  formData.append('files', blob, `${bwRef}${suffix}.pdf`);

  const headers = await makeHeaders();
  delete headers.Accept;
  console.log(`[CB] Uploading PDF${suffix} for ${bwRef}…`);
  const res = await fetchWithTimeout('https://www.bookaway.com/_api/images/upload/files', {
    method: 'POST', headers, body: formData
  }, 60_000);

  if (res.status === 401 || res.status === 403) { invalidateToken(); throw new Error(`Upload auth failed ${res.status}`); }
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Upload failed ${res.status}: ${t.slice(0, 150)}`); }

  const data = await res.json();
  const att = Array.isArray(data) ? data[0] : data;
  if (!att?.id && att?._id) att.id = att._id;
  if (!att?.id) throw new Error('Upload returned no file ID');
  return { id: att.id, url: att.url || `${att.id}.pdf`, name: `${bwRef}${suffix}.pdf`, ...(att.thumbnailUrl ? { thumbnailUrl: att.thumbnailUrl } : {}) };
}

async function approveClickbusBooking(bookingId, bwRef, seats, passengers, pdfBuffer, opts = {}) {
  // opts: { returnSeats, returnPdfBuffer } for round trips
  if (DRY_RUN) {
    console.log(`[CB] [DRY_RUN] Would approve ${bwRef}${opts.returnPdfBuffer ? ' (round trip)' : ''}`);
    return { success: true, bwRef, dry: true };
  }

  const depAttachment = await uploadPdf(bookingId, bwRef, pdfBuffer, '-departure');

  let retAttachment = null;
  if (opts.returnPdfBuffer) {
    retAttachment = await uploadPdf(bookingId, bwRef, opts.returnPdfBuffer, '-return');
  }

  const approvePayload = {
    extras: [],
    pickups:  [{ time: 0, location: null }],
    dropOffs: [null],
    voucherAttachments: retAttachment ? [depAttachment, retAttachment] : [depAttachment],
    approvalInputs: {
      bookingCode: (seats || []).join(' '),
      departureTrip: { seatsNumber: seats || [],                ticketsQrCode: [] },
      returnTrip:    { seatsNumber: opts.returnSeats || [],     ticketsQrCode: [] }
    }
  };

  console.log(`[CB] Aprobando booking ${bwRef}…`);
  const approveRes = await fetchWithTimeout(`${BASE}/v2/bookings/${bookingId}/approve`, {
    method: 'POST',
    headers: { ...(await makeHeaders()), 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify(approvePayload)
  });

  if (approveRes.status === 401 || approveRes.status === 403) {
    invalidateToken();
    throw new Error(`Approve auth failed ${approveRes.status} — token invalidado`);
  }
  if (!approveRes.ok) {
    const t = await approveRes.text().catch(() => '');
    throw new Error(`Approve failed ${approveRes.status}: ${t.slice(0, 200)}`);
  }

  console.log(`[CB] Booking ${bwRef} aprobada`);
  return { success: true, bwRef, dry: false };
}

module.exports = { processClickbusTicket, approveClickbusBooking, DRY_RUN };
