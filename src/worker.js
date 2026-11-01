// QuestHouse — сервер для Telegram Mini App (Cloudflare Worker + D1)
// Секреты: BOT_TOKEN (токен бота), WEBHOOK_SECRET (защита вебхука)

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const now = () => Date.now();
const H = 3600e3;

/* ---------- Проверка, что запрос пришёл из Telegram (initData) ---------- */
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
async function checkInitData(initData, botToken) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash'); if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac('WebAppData', botToken);
  if (hex(await hmac(secret, dcs)) !== hash) return null;
  if (now() / 1000 - Number(p.get('auth_date') || 0) > 7 * 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

/* ---------- Telegram Bot API ---------- */
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json().catch(() => ({}));
}
const appUrl = req => new URL(req.url).origin + '/';

async function notifyRole(env, roles, text) {
  const { results } = await env.DB.prepare(
    `SELECT tg_id FROM users WHERE status='approved' AND role IN (${roles.map(() => '?').join(',')})`).bind(...roles).all();
  for (const u of results) await tg(env, 'sendMessage', { chat_id: u.tg_id, text, parse_mode: 'HTML' });
}
const escH = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/* ---------- Пользователи ---------- */
async function getUser(env, tgUser) {
  const db = env.DB;
  let u = await db.prepare('SELECT * FROM users WHERE tg_id=?').bind(tgUser.id).first();
  const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ');
  if (!u) {
    const cnt = await db.prepare('SELECT COUNT(*) c FROM users').first();
    const first = !cnt || cnt.c === 0; // первый вошедший — владелец
    u = { tg_id: tgUser.id, name, username: tgUser.username || '', role: first ? 'owner' : 'admin', status: first ? 'approved' : 'pending', created: now(), last_seen: now() };
    await db.prepare('INSERT INTO users (tg_id,name,username,role,status,created,last_seen) VALUES (?,?,?,?,?,?,?)')
      .bind(u.tg_id, u.name, u.username, u.role, u.status, u.created, u.last_seen).run();
    if (!first) await notifyRole(env, ['owner'], `👤 Новый запрос доступа: <b>${escH(name)}</b>${tgUser.username ? ' @' + escH(tgUser.username) : ''}\nОдобрить: Настройки → Сотрудники`);
  } else {
    await db.prepare('UPDATE users SET last_seen=?, name=?, username=? WHERE tg_id=?').bind(now(), name, tgUser.username || '', tgUser.id).run();
  }
  return u;
}
const canAll = u => u.status === 'approved' && (u.role === 'owner' || u.role === 'admin');
const canVideo = u => u.status === 'approved';
const isOwner = u => u.status === 'approved' && u.role === 'owner';

/* ---------- API ---------- */
async function api(req, env, path) {
  const tgUser = await checkInitData((req.headers.get('authorization') || '').replace(/^tma /, ''), env.BOT_TOKEN);
  if (!tgUser) return json({ error: 'unauthorized' }, 401);
  const u = await getUser(env, tgUser);
  const db = env.DB, m = req.method;
  const body = m === 'PUT' || m === 'POST' ? await req.json().catch(() => ({})) : null;
  const parts = path.split('/').filter(Boolean); // ['me'] | ['booking', id] ...

  if (parts[0] === 'me') return json({ user: u });
  if (u.status !== 'approved') return json({ error: 'pending', user: u }, 403);

  // Все данные (или только изменения с момента since)
  if (parts[0] === 'data' && m === 'GET') {
    const since = Number(new URL(req.url).searchParams.get('since') || 0);
    const t = now();
    const out = { t, role: u.role };
    const s = await db.prepare('SELECT data, updated FROM settings WHERE k=?').bind('main').first();
    if (s && s.updated > since) out.settings = JSON.parse(s.data);
    out.videos = (await db.prepare('SELECT data, deleted FROM videos WHERE updated>?').bind(since).all()).results
      .map(r => ({ ...JSON.parse(r.data), _deleted: !!r.deleted }));
    if (canAll(u)) {
      out.bookings = (await db.prepare('SELECT data, deleted FROM bookings WHERE updated>?').bind(since).all()).results
        .map(r => ({ ...JSON.parse(r.data), _deleted: !!r.deleted }));
      out.reports = (await db.prepare('SELECT date, data, deleted FROM reports WHERE updated>?').bind(since).all()).results
        .map(r => ({ date: r.date, ...JSON.parse(r.data), _deleted: !!r.deleted }));
    } else {
      // монтажёру — только сегодняшние брони (для выбора команды при добавлении видео)
      const today = new Date(t + 5 * H).toISOString().slice(0, 10);
      out.bookings = (await db.prepare('SELECT data, deleted FROM bookings WHERE date=? AND updated>?').bind(today, since).all()).results
        .map(r => ({ ...JSON.parse(r.data), _deleted: !!r.deleted }));
      out.reports = [];
    }
    return json(out);
  }

  if (parts[0] === 'booking') {
    if (!canAll(u)) return json({ error: 'forbidden' }, 403);
    if (m === 'PUT') {
      const b = body; if (!b.id || !b.date) return json({ error: 'bad' }, 400);
      await db.prepare('INSERT INTO bookings (id,date,data,updated,deleted,by_user) VALUES (?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET date=excluded.date,data=excluded.data,updated=excluded.updated,deleted=0,by_user=excluded.by_user')
        .bind(b.id, b.date, JSON.stringify(b), now(), u.tg_id).run();
      return json({ ok: true });
    }
    if (m === 'DELETE') { await db.prepare('UPDATE bookings SET deleted=1, updated=? WHERE id=?').bind(now(), parts[1]).run(); return json({ ok: true }); }
  }

  if (parts[0] === 'report') {
    if (!canAll(u)) return json({ error: 'forbidden' }, 403);
    const date = parts[1];
    if (m === 'PUT') {
      await db.prepare('INSERT INTO reports (date,data,updated,deleted,by_user) VALUES (?,?,?,0,?) ON CONFLICT(date) DO UPDATE SET data=excluded.data,updated=excluded.updated,deleted=0,by_user=excluded.by_user')
        .bind(date, JSON.stringify({ ...body, by: u.name }), now(), u.tg_id).run();
      return json({ ok: true });
    }
    if (m === 'DELETE') { await db.prepare('UPDATE reports SET deleted=1, updated=? WHERE date=?').bind(now(), date).run(); return json({ ok: true }); }
  }

  if (parts[0] === 'video') {
    if (!canVideo(u)) return json({ error: 'forbidden' }, 403);
    if (m === 'PUT') {
      const v = body; if (!v.id) return json({ error: 'bad' }, 400);
      const old = await db.prepare('SELECT done, deadline FROM videos WHERE id=?').bind(v.id).first();
      const resetFlags = old && old.deadline !== v.deadline;
      await db.prepare(`INSERT INTO videos (id,data,deadline,done,updated,deleted,by_user) VALUES (?,?,?,?,?,0,?)
        ON CONFLICT(id) DO UPDATE SET data=excluded.data,deadline=excluded.deadline,done=excluded.done,updated=excluded.updated,deleted=0${resetFlags ? ',n24=0,nover=0' : ''}`)
        .bind(v.id, JSON.stringify(v), v.deadline, v.done ? 1 : 0, now(), u.tg_id).run();
      if (!old) await notifyRole(env, ['video'], `🎬 Новое видео: <b>${escH(v.team || 'команда')}</b> · ${escH(v.quest)}\nСдать до ${fmtTash(v.deadline)}`);
      if (old && !old.done && v.done) await notifyRole(env, ['owner'], `✅ Видео сдано: <b>${escH(v.team)}</b> · ${escH(v.quest)} (${escH(u.name)})`);
      return json({ ok: true });
    }
    if (m === 'DELETE') { await db.prepare('UPDATE videos SET deleted=1, updated=? WHERE id=?').bind(now(), parts[1]).run(); return json({ ok: true }); }
  }

  if (parts[0] === 'settings' && m === 'PUT') {
    if (!canAll(u)) return json({ error: 'forbidden' }, 403);
    await db.prepare('INSERT INTO settings (k,data,updated) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET data=excluded.data, updated=excluded.updated')
      .bind('main', JSON.stringify(body), now()).run();
    return json({ ok: true });
  }

  if (parts[0] === 'users') {
    if (!isOwner(u)) return json({ error: 'forbidden' }, 403);
    if (m === 'GET') return json({ users: (await db.prepare('SELECT * FROM users ORDER BY created').all()).results });
    if (m === 'PUT') {
      const id = Number(parts[1]); if (id === u.tg_id) return json({ error: 'self' }, 400);
      const role = ['admin', 'video', 'owner'].includes(body.role) ? body.role : 'admin';
      const status = ['approved', 'pending', 'blocked'].includes(body.status) ? body.status : 'pending';
      const before = await db.prepare('SELECT status FROM users WHERE tg_id=?').bind(id).first();
      await db.prepare('UPDATE users SET role=?, status=? WHERE tg_id=?').bind(role, status, id).run();
      if (before && before.status !== 'approved' && status === 'approved')
        await tg(env, 'sendMessage', { chat_id: id, text: '✅ Доступ открыт! Нажмите «Открыть» внизу слева.', reply_markup: { inline_keyboard: [[{ text: 'Открыть приложение', web_app: { url: appUrl(req) } }]] } });
      return json({ ok: true });
    }
    if (m === 'DELETE') { await db.prepare('DELETE FROM users WHERE tg_id=? AND tg_id<>?').bind(Number(parts[1]), u.tg_id).run(); return json({ ok: true }); }
  }
  return json({ error: 'not found' }, 404);
}

function fmtTash(ms) {
  const d = new Date(ms + 5 * H); // Ташкент UTC+5
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/* ---------- Вебхук бота ---------- */
async function webhook(req, env) {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('no', { status: 403 });
  const upd = await req.json().catch(() => ({}));
  const msg = upd.message;
  if (msg && msg.text) {
    const kb = { inline_keyboard: [[{ text: '📅 Открыть приложение', web_app: { url: appUrl(req) } }]] };
    if (msg.text.startsWith('/start') || msg.text.startsWith('/app'))
      await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: 'QuestHouse — брони, касса и видео.\nНажмите кнопку ниже или «Открыть» слева от поля ввода.', reply_markup: kb });
    else if (msg.text.startsWith('/id'))
      await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: `Ваш Telegram ID: ${msg.from.id}` });
  }
  return new Response('ok');
}

/* ---------- Напоминания о видео (cron) ---------- */
async function remind(env) {
  const t = now();
  const { results } = await env.DB.prepare('SELECT id, data, deadline, n24, nover FROM videos WHERE done=0 AND deleted=0').all();
  for (const r of results) {
    const v = JSON.parse(r.data), left = r.deadline - t;
    if (left <= 0 && !r.nover) {
      await notifyRole(env, ['video', 'owner'], `🔴 Видео просрочено: <b>${escH(v.team)}</b> · ${escH(v.quest)}\nСрок был ${fmtTash(r.deadline)}`);
      await env.DB.prepare('UPDATE videos SET nover=1, n24=1 WHERE id=?').bind(r.id).run();
    } else if (left > 0 && left <= 24 * H && !r.n24) {
      await notifyRole(env, ['video'], `🟠 Остались сутки: <b>${escH(v.team)}</b> · ${escH(v.quest)}\nСдать до ${fmtTash(r.deadline)}`);
      await env.DB.prepare('UPDATE videos SET n24=1 WHERE id=?').bind(r.id).run();
    }
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, env, url.pathname.slice(5));
      if (url.pathname === '/tg' && req.method === 'POST') return await webhook(req, env);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(remind(env)); }
};
