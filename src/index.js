// Worker: API untuk form HP + sinkronisasi dengan Google Sheet (via Apps Script)

const COLS = [
  'device_id', 'device_name', 'license_plate', 'class_id', 'device_year', 'device_usage_km',
  'utility_status', 'condition_status', 'maintenance_status', 'dedicated_status',
  'device_pool_id', 'location_unit', 'validasi_utility_status', 'tgl_masuk_pool',
  'grading_body', 'grading_total', 'jenis_perbaikan', 'grade_kerusakan',
  'tgl_masuk_bengkel', 'estimasi_selesai', 'tgl_aktual_selesai', 'tgl_usp',
  'progress_today', 'progress_h1', 'workshop_name', 'idle_time_uts', 'sla_in_to_usp', 'idle_time_usp',
];

// 4 kolom yang diisi lewat form. Setelah satu baris pernah diubah lewat form,
// sinkron dari Sheet tidak boleh menimpanya lagi.
const PROTECTED = ['tgl_masuk_pool', 'tgl_masuk_bengkel', 'estimasi_selesai', 'progress_today'];

const sets = COLS.filter((c) => c !== 'device_id')
  .map((c) => PROTECTED.includes(c)
    ? `${c}=CASE WHEN units.form_updated_at IS NULL THEN excluded.${c} ELSE units.${c} END`
    : `${c}=excluded.${c}`)
  .join(',');

// WHERE di akhir: baris yang tidak berubah (hash sama) tidak ditulis, jadi hemat kuota tulis harian.
const UPSERT =
  `INSERT INTO units (${COLS.join(',')},row_hash) VALUES (${COLS.map(() => '?').join(',')},?) ` +
  `ON CONFLICT(device_id) DO UPDATE SET ${sets},row_hash=excluded.row_hash,updated_at=datetime('now') ` +
  `WHERE units.row_hash IS NOT excluded.row_hash`;

const json = (o, status = 200, headers = {}) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });

async function token(env) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.APP_PIN + ':' + env.SYNC_KEY));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function authed(req, env) {
  return (req.headers.get('cookie') || '').includes('auth=' + (await token(env)));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function okDate(s) {
  if (!DATE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d)) return false;
  const y = d.getUTCFullYear();
  return d.toISOString().slice(0, 10) === s && y >= 2020 && y <= 2035;
}

async function login(req, env) {
  const { pin } = await req.json();
  if (!env.APP_PIN || pin !== env.APP_PIN) return json({ error: 'PIN salah' }, 401);
  return json({ ok: true }, 200, {
    'set-cookie': 'auth=' + (await token(env)) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000',
  });
}

// Daftar ringan (id, nopol, nama). Browser menyimpannya 5 menit supaya tidak menarik data terus.
async function units(env) {
  const { results } = await env.DB.prepare(
    'SELECT device_id AS id, license_plate AS plate, device_name AS name FROM units WHERE license_plate IS NOT NULL ORDER BY license_plate'
  ).all();
  return json(results, 200, { 'cache-control': 'private, max-age=300' });
}

async function unit(u, env) {
  const r = await env.DB.prepare('SELECT * FROM units WHERE device_id=?').bind(u.searchParams.get('id')).first();
  if (!r) return json({ error: 'Unit tidak ditemukan' }, 404);
  delete r.row_hash;
  return json(r);
}

async function save(req, env) {
  const b = await req.json();
  const clean = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
  const pool = clean(b.tgl_masuk_pool);
  const bkl = clean(b.tgl_masuk_bengkel);
  let est = clean(b.estimasi_selesai);
  if (est) est = est.toUpperCase();
  const prog = clean(b.progress_today);

  if (!b.device_id) return json({ error: 'Pilih unit dulu' }, 400);
  if (pool && !okDate(pool)) return json({ error: 'Tanggal Masuk Pool tidak valid' }, 400);
  if (bkl && !okDate(bkl)) return json({ error: 'Tanggal Masuk Bengkel tidak valid' }, 400);
  if (est && !['CTL', 'TLO'].includes(est) && !okDate(est))
    return json({ error: 'Estimasi Unit Selesai harus tanggal, CTL, atau TLO' }, 400);
  if (prog && prog.length > 500) return json({ error: 'Progress maksimal 500 karakter' }, 400);

  const r = await env.DB.prepare(
    "UPDATE units SET tgl_masuk_pool=?1, tgl_masuk_bengkel=?2, estimasi_selesai=?3, progress_today=?4, " +
    "form_updated_at=datetime('now'), updated_at=datetime('now') WHERE device_id=?5"
  ).bind(pool, bkl, est, prog, b.device_id).run();
  return r.meta.changes ? json({ ok: true }) : json({ error: 'Unit tidak ditemukan' }, 404);
}

// Dipanggil Apps Script: kirim baris dari Sheet (maks 40 per request)
async function sync(req, env) {
  const rows = await req.json();
  if (!Array.isArray(rows) || rows.length > 40) return json({ error: 'Maksimal 40 baris per request' }, 400);
  const st = env.DB.prepare(UPSERT);
  const batch = rows
    .filter((r) => r.device_id)
    .map((r) => st.bind(...COLS.map((c) => r[c] ?? null), r.row_hash ?? null));
  if (batch.length) await env.DB.batch(batch);
  return json({ ok: true, n: batch.length });
}

// Dipanggil Apps Script: ambil baris yang diubah lewat form, untuk ditulis balik ke Sheet
async function changes(u, env) {
  const { results } = await env.DB.prepare(
    'SELECT device_id, tgl_masuk_pool, tgl_masuk_bengkel, estimasi_selesai, progress_today, form_updated_at ' +
    'FROM units WHERE form_updated_at >= ? ORDER BY form_updated_at'
  ).bind(u.searchParams.get('since') || '').all();
  return json(results);
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const p = u.pathname;
    try {
      if (p === '/api/login' && req.method === 'POST') return await login(req, env);

      if (p === '/api/sync' || p === '/api/changes') {
        if (req.headers.get('x-api-key') !== env.SYNC_KEY) return json({ error: 'Kunci salah' }, 401);
        return p === '/api/sync' ? await sync(req, env) : await changes(u, env);
      }

      if (p.startsWith('/api/')) {
        if (!(await authed(req, env))) return json({ error: 'Belum login' }, 401);
        if (p === '/api/units') return await units(env);
        if (p === '/api/unit') return await unit(u, env);
        if (p === '/api/save' && req.method === 'POST') return await save(req, env);
      }
      return json({ error: 'Tidak ditemukan' }, 404);
    } catch (e) {
      return json({ error: 'Server: ' + e.message }, 500);
    }
  },
};
