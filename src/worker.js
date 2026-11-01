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
  const r = await fetch(`${env.TG_API || 'https://api.telegram.org'}/bot${env.BOT_TOKEN}/${method}`, {
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
// Права: все одобренные — брони и просмотр всего; касс-отчёт — владелец или с флагом cash_edit;
// «Видео сдано» — владелец или монтаж; настройки и сотрудники — только владелец.
const approved = u => u.status === 'approved';
const isOwner = u => approved(u) && u.role === 'owner';
const canCash = u => isOwner(u) || (approved(u) && !!u.cash_edit);
const canVideoDone = u => isOwner(u) || (approved(u) && u.role === 'video');

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
    out.bookings = (await db.prepare('SELECT data, deleted FROM bookings WHERE updated>?').bind(since).all()).results
      .map(r => ({ ...JSON.parse(r.data), _deleted: !!r.deleted }));
    out.reports = (await db.prepare('SELECT date, data, deleted FROM reports WHERE updated>?').bind(since).all()).results
      .map(r => ({ date: r.date, ...JSON.parse(r.data), _deleted: !!r.deleted }));
    out.me = u;
    return json(out);
  }

  if (parts[0] === 'booking') {
    if (!approved(u)) return json({ error: 'forbidden' }, 403);
    if (m === 'PUT') {
      const b = body; if (!b.id || !b.date) return json({ error: 'bad' }, 400);
      b.by = b.by || u.name;
      const old = await db.prepare('SELECT data, notified FROM bookings WHERE id=?').bind(b.id).first();
      await db.prepare('INSERT INTO bookings (id,date,data,updated,deleted,by_user) VALUES (?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET date=excluded.date,data=excluded.data,updated=excluded.updated,deleted=0,by_user=excluded.by_user')
        .bind(b.id, b.date, JSON.stringify(b), now(), u.tg_id).run();
      await bookingNotify(env, b, old ? JSON.parse(old.data) : null, old ? old.notified : 0);
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      const old = await db.prepare('SELECT data, notified FROM bookings WHERE id=?').bind(parts[1]).first();
      await db.prepare('UPDATE bookings SET deleted=1, updated=? WHERE id=?').bind(now(), parts[1]).run();
      if (old && old.notified) { const b = JSON.parse(old.data); await groupSend(env, `🗑 <b>Бронь удалена</b>\n${bookingLine(b)}\nУдалил: ${escH(u.name)}`, 'notifyBookings'); }
      return json({ ok: true });
    }
  }

  if (parts[0] === 'report') {
    if (!canCash(u)) return json({ error: 'forbidden' }, 403);
    const date = parts[1];
    if (m === 'PUT') {
      await db.prepare('INSERT INTO reports (date,data,updated,deleted,by_user) VALUES (?,?,?,0,?) ON CONFLICT(date) DO UPDATE SET data=excluded.data,updated=excluded.updated,deleted=0,by_user=excluded.by_user')
        .bind(date, JSON.stringify({ ...body, by: u.name }), now(), u.tg_id).run();
      return json({ ok: true });
    }
    if (m === 'DELETE') { await db.prepare('UPDATE reports SET deleted=1, updated=? WHERE date=?').bind(now(), date).run(); return json({ ok: true }); }
  }

  if (parts[0] === 'video') {
    if (!approved(u)) return json({ error: 'forbidden' }, 403);
    if (m === 'PUT') {
      const v = body; if (!v.id) return json({ error: 'bad' }, 400);
      const old = await db.prepare('SELECT done, deadline FROM videos WHERE id=?').bind(v.id).first();
      if (!!(old && old.done) !== !!v.done && !canVideoDone(u)) return json({ error: 'forbidden' }, 403);
      const resetFlags = old && old.deadline !== v.deadline;
      await db.prepare(`INSERT INTO videos (id,data,deadline,done,updated,deleted,by_user) VALUES (?,?,?,?,?,0,?)
        ON CONFLICT(id) DO UPDATE SET data=excluded.data,deadline=excluded.deadline,done=excluded.done,updated=excluded.updated,deleted=0${resetFlags ? ',n24=0,nover=0' : ''}`)
        .bind(v.id, JSON.stringify(v), v.deadline, v.done ? 1 : 0, now(), u.tg_id).run();
      if (!old) {
        await notifyRole(env, ['video'], `🎬 Новое видео: <b>${escH(v.team || 'команда')}</b> · ${escH(v.quest)}\nСдать до ${fmtTash(v.deadline)}`);
        await groupSend(env, `🎬 <b>Купили видео</b>\n${escH(v.team || 'команда')} · ${escH(v.quest)}\nСдать до ${fmtTash(v.deadline)}`, null, 'videos');
      }
      if (old && !old.done && v.done) await groupSend(env, `✅ <b>Видео сдано</b>\n${escH(v.team)} · ${escH(v.quest)}`, null, 'videos');
      if (old && !old.done && v.done) await notifyRole(env, ['owner'], `✅ Видео сдано: <b>${escH(v.team)}</b> · ${escH(v.quest)} (${escH(u.name)})`);
      return json({ ok: true });
    }
    if (m === 'DELETE') { await db.prepare('UPDATE videos SET deleted=1, updated=? WHERE id=?').bind(now(), parts[1]).run(); return json({ ok: true }); }
  }

  if (parts[0] === 'group') {
    if (m === 'POST' && parts[1] === 'send') { // отправить готовый текст отчёта в группу
      if (!canCash(u) && !isOwner(u)) return json({ error: 'forbidden' }, 403);
      const r = await groupSend(env, escH(String(body.text || '')).slice(0, 4000), null, 'reports');
      return json({ ok: !!r, error: r ? undefined : 'Группа не подключена' }, r ? 200 : 400);
    }
    if (!isOwner(u)) return json({ error: 'forbidden' }, 403);
    if (m === 'GET') return json({ group: await getKV(env, 'group') });
    if (m === 'POST' && parts[1] === 'test') {
      const r1 = await groupSend(env, '✅ Тест: сюда будут приходить брони', null, 'bookings');
      const r2 = await groupSend(env, '✅ Тест: сюда будут приходить касса и итоги дня', null, 'reports');
      const g = await getKV(env, 'group'); if (g && g.topics && g.topics.videos) await groupSend(env, '✅ Тест: сюда будут приходить видео', null, 'videos');
      const r = r1 && r2; return json({ ok: !!r }); }
    if (m === 'POST' && parts[1] === 'daily') { const r = await dailyReport(env, body.date || tashDate()); return json({ ok: !!r }); }
    if (m === 'DELETE') { await db.prepare('DELETE FROM settings WHERE k=?').bind('group').run(); return json({ ok: true }); }
  }

  if (parts[0] === 'settings' && m === 'PUT') {
    if (!isOwner(u)) return json({ error: 'forbidden' }, 403);
    await db.prepare('INSERT INTO settings (k,data,updated) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET data=excluded.data, updated=excluded.updated')
      .bind('main', JSON.stringify(body), now()).run();
    return json({ ok: true });
  }

  if (parts[0] === 'users') {
    if (!isOwner(u)) return json({ error: 'forbidden' }, 403);
    if (m === 'GET') return json({ users: (await db.prepare('SELECT * FROM users ORDER BY created').all()).results });
    if (m === 'PUT') {
      const id = Number(parts[1]); if (id === u.tg_id) return json({ error: 'self' }, 400);
      const before = await db.prepare('SELECT * FROM users WHERE tg_id=?').bind(id).first();
      if (!before) return json({ error: 'not found' }, 404);
      const role = ['admin', 'video'].includes(body.role) ? body.role : before.role;
      const status = ['approved', 'pending', 'blocked'].includes(body.status) ? body.status : before.status;
      const cash = body.cash_edit === undefined ? (before.cash_edit || 0) : (body.cash_edit ? 1 : 0);
      await db.prepare('UPDATE users SET role=?, status=?, cash_edit=? WHERE tg_id=?').bind(role, status, cash, id).run();
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

/* ---------- Группа ---------- */
async function getKV(env, k) { const r = await env.DB.prepare('SELECT data FROM settings WHERE k=?').bind(k).first(); return r ? JSON.parse(r.data) : null; }
async function setKV(env, k, v) { await env.DB.prepare('INSERT INTO settings (k,data,updated) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET data=excluded.data, updated=excluded.updated').bind(k, JSON.stringify(v), now()).run(); }
async function getSettings(env) { return (await getKV(env, 'main')) || {}; }
// flag — имя настройки-переключателя (notifyBookings / dailyReport); по умолчанию включено
// topic: 'bookings' | 'reports' | 'videos' — отдельные темы (подразделы) группы
async function groupSend(env, text, flag, topic) {
  const g = await getKV(env, 'group'); if (!g || !g.chat_id) return null;
  if (flag) { const st = await getSettings(env); if (st[flag] === false) return null; }
  if (!topic && flag === 'notifyBookings') topic = 'bookings';
  const thread = topic && g.topics && g.topics[topic];
  if (topic === 'videos' && !thread) return null; // видео в группу — только если подключена своя тема
  const send = (chat_id, th) => tg(env, 'sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(th ? { message_thread_id: th } : {}) });
  let r = await send(g.chat_id, thread);
  if (!r.ok && r.parameters && r.parameters.migrate_to_chat_id) { // группа стала супергруппой
    g.chat_id = r.parameters.migrate_to_chat_id; await setKV(env, 'group', g); r = await send(g.chat_id, thread);
  }
  if (!r.ok && thread && /thread|topic/i.test(r.description || '')) r = await send(g.chat_id); // тему удалили — шлём в общий чат
  return r.ok ? r : null;
}
const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
function humanDate(ds) { const [y, m, d] = ds.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); return `${WD[dt.getUTCDay()]}, ${d} ${MON[m - 1]}`; }
const money = n => String(Math.round(+n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' сум';
const tashDate = (ms = now()) => new Date(ms + 5 * H).toISOString().slice(0, 10);
function finalPrice(b) { const p = +b.price || 0, d = +b.discount || 0; return Math.max(0, Math.round(p - (b.discType === 'pct' ? p * d / 100 : d))); }
const bookingLine = b => `🎯 <b>${escH(b.quest)}</b> · ${humanDate(b.date)} · <b>${escH(b.time)}</b>${b.name ? ' · ' + escH(b.name) : ''}`;
function bookingText(b) {
  const fp = finalPrice(b), disc = fp !== (+b.price || 0);
  let t = `🆕 <b>Новая бронь</b>\n🎯 <b>${escH(b.quest)}</b>\n📅 ${humanDate(b.date)} · <b>${escH(b.time)}</b>\n`;
  t += `👤 ${escH(b.name || 'без имени')}${b.phone ? ' · ' + escH(b.phone) : ''}\n👥 ${escH(b.guests || '?')} чел.\n`;
  t += `💰 ${money(fp)}${disc ? ` (скидка ${b.discType === 'pct' ? b.discount + '%' : money(b.discount)})` : ''}`;
  if (+b.prepay) t += ` · предоплата ${money(b.prepay)}`;
  if (b.comment) t += `\n📝 ${escH(b.comment)}`;
  if (b.by) t += `\n<i>Добавил(а): ${escH(b.by)}</i>`;
  return t;
}
async function bookingNotify(env, b, old, notified) {
  if (!notified) {
    // ждём, пока впишут имя или телефон; если не впишут — cron отправит через 3 минуты
    if ((b.name || b.phone) && b.status !== 'cancel') {
      if (await groupSend(env, bookingText(b), 'notifyBookings')) await env.DB.prepare('UPDATE bookings SET notified=1 WHERE id=?').bind(b.id).run();
    }
    return;
  }
  if (!old) return;
  if (b.status === 'cancel' && old.status !== 'cancel') return groupSend(env, `❌ <b>Бронь отменена</b>\n${bookingLine(b)}`, 'notifyBookings');
  if (old.status === 'cancel' && b.status !== 'cancel') return groupSend(env, `♻️ <b>Бронь восстановлена</b>\n${bookingLine(b)}`, 'notifyBookings');
  if (old.date !== b.date || old.time !== b.time || old.quest !== b.quest)
    return groupSend(env, `🔁 <b>Бронь перенесена</b>\nбыло: ${escH(old.quest)} · ${humanDate(old.date)} · ${escH(old.time)}\nстало: ${bookingLine(b)}`, 'notifyBookings');
}
function split(st, bookings) {
  const quests = st.quests || [], mgmt = st.mgmt || [];
  const byQ = {}; quests.forEach(q => byQ[q.name] = { q, games: 0, revenue: 0 });
  for (const b of bookings) { if (b.status === 'cancel') continue; const r = byQ[b.quest] || (byQ[b.quest] = { q: { name: b.quest, actors: 0 }, games: 0, revenue: 0 }); r.games++; r.revenue += finalPrice(b); }
  const tot = { games: 0, revenue: 0, actors: 0, owner: 0, mg: mgmt.map(m => ({ name: m.name, pct: +m.pct || 0, sum: 0 })) };
  const rows = Object.values(byQ).map(r => {
    const actors = r.games * (+r.q.actors || 0), base = r.revenue - actors; let mgSum = 0;
    mgmt.forEach((m, i) => { const v = base * (+m.pct || 0) / 100; tot.mg[i].sum += v; mgSum += v; });
    tot.games += r.games; tot.revenue += r.revenue; tot.actors += actors; tot.owner += base - mgSum;
    return { ...r, actors };
  });
  return { rows, tot };
}
async function dailyReport(env, date) {
  const st = await getSettings(env);
  const bookings = (await env.DB.prepare('SELECT data FROM bookings WHERE date=? AND deleted=0').bind(date).all()).results.map(r => JSON.parse(r.data));
  const { rows, tot } = split(st, bookings);
  const cancelled = bookings.filter(b => b.status === 'cancel').length;
  let t = `📊 <b>Итоги дня · ${humanDate(date)}</b>\n\nИгр: <b>${tot.games}</b>${cancelled ? ` (отмен: ${cancelled})` : ''}\nВыручка: <b>${money(tot.revenue)}</b>\n`;
  for (const r of rows) if (r.games) t += `  • ${escH(r.q.name)}: ${r.games} — ${money(r.revenue)}\n`;
  if (tot.games) {
    t += `\nАктёры: ${money(tot.actors)}\n`;
    tot.mg.forEach(m => t += `${escH(m.name)} ${m.pct}%: ${money(m.sum)}\n`);
    t += `${escH(st.ownerName || 'Остаток')}: <b>${money(tot.owner)}</b>\n`;
  }
  const rep = await env.DB.prepare('SELECT data FROM reports WHERE date=? AND deleted=0').bind(date).first();
  if (rep) {
    const d = JSON.parse(rep.data), vals = d.values || {}; let pin = 0, pout = 0;
    t += `\n💵 <b>Касса</b>${d.by ? ' (' + escH(d.by) + ')' : ''}\n`;
    (st.payFields || []).forEach(f => { if (vals[f] != null) { pin += +vals[f]; t += `  • ${escH(f)}: ${money(vals[f])}\n`; } });
    (st.expenseFields || []).forEach(f => { if (vals[f] != null) { pout += +vals[f]; t += `  • ${escH(f)}: −${money(vals[f])}\n`; } });
    t += `Остаток в кассе: <b>${money(pin - pout)}</b>\n`;
    if (pin !== tot.revenue) t += `⚠️ Расхождение с бронями: ${pin > tot.revenue ? '+' : '−'}${money(Math.abs(pin - tot.revenue))}\n`;
    if (d.note) t += `📝 ${escH(d.note)}\n`;
  } else if (tot.games) t += `\n⚠️ Касс-отчёт за день не создан`;
  return groupSend(env, t.trim(), null, 'reports');
}

/* ---------- Вебхук бота ---------- */
async function webhook(req, env) {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('no', { status: 403 });
  const upd = await req.json().catch(() => ({}));
  const msg = upd.message;
  if (upd.my_chat_member && ['group', 'supergroup'].includes(upd.my_chat_member.chat.type) && ['member', 'administrator'].includes(upd.my_chat_member.new_chat_member.status)
      && !['member', 'administrator'].includes(upd.my_chat_member.old_chat_member.status))
    await tg(env, 'sendMessage', { chat_id: upd.my_chat_member.chat.id, text: 'Привет! Чтобы получать сюда брони и отчёты, владелец должен отправить в эту группу команду /connect' });
  if (msg && msg.migrate_to_chat_id) { const g = await getKV(env, 'group'); if (g && g.chat_id === msg.chat.id) { g.chat_id = msg.migrate_to_chat_id; await setKV(env, 'group', g); } }
  if (msg && msg.text && ['group', 'supergroup'].includes(msg.chat.type)) {
    const cmd = (msg.text.match(/^\/(connect|bookings|reports|videos)(@\w+)?(\s|$)/) || [])[1];
    if (cmd) {
      const u = await env.DB.prepare("SELECT * FROM users WHERE tg_id=? AND role='owner' AND status='approved'").bind(msg.from.id).first();
      if (!u) { await tg(env, 'sendMessage', { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: 'Подключать группу может только владелец приложения.' }); return new Response('ok'); }
      let g = await getKV(env, 'group');
      if (!g || g.chat_id !== msg.chat.id) g = { chat_id: msg.chat.id, topics: {} };
      g.title = msg.chat.title; g.at = now(); g.topics = g.topics || {};
      const thread = msg.is_topic_message ? msg.message_thread_id : null;
      const names = { bookings: 'брони', reports: 'касса и итоги дня', videos: 'видео' };
      let text;
      if (cmd === 'connect') text = '✅ Группа подключена!\nЧтобы разнести по подразделам (темам), отправьте в нужной теме:\n/bookings — сюда брони\n/reports — сюда касса и итоги дня\n/videos — сюда видео (по желанию)';
      else if (!thread) { delete g.topics[cmd]; text = `✅ ${names[cmd][0].toUpperCase() + names[cmd].slice(1)} будут приходить в общий чат.${msg.chat.is_forum ? '\nЧтобы в отдельную тему — отправьте команду внутри этой темы.' : ''}`; }
      else { g.topics[cmd] = thread; text = `✅ В эту тему будут приходить: ${names[cmd]}`; }
      await setKV(env, 'group', g);
      await tg(env, 'sendMessage', { chat_id: msg.chat.id, text, ...(thread ? { message_thread_id: thread } : {}) });
    }
    return new Response('ok');
  }
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
  // брони, созданные в 1 клик без имени: отправляем в группу через 3 минуты
  const pend = (await env.DB.prepare('SELECT id, data FROM bookings WHERE notified=0 AND deleted=0 AND updated<?').bind(t - 3 * 60e3).all()).results;
  for (const r of pend) {
    const b = JSON.parse(r.data);
    if (b.status !== 'cancel' && await groupSend(env, bookingText(b), 'notifyBookings')) await env.DB.prepare('UPDATE bookings SET notified=1 WHERE id=?').bind(r.id).run();
    else if (b.status === 'cancel') await env.DB.prepare('UPDATE bookings SET notified=2 WHERE id=?').bind(r.id).run();
  }
  // итоги дня в группу в заданное время (по Ташкенту)
  const st = await getSettings(env);
  if (st.dailyReport !== false) {
    const [hh, mm] = String(st.dailyTime || '23:30').split(':').map(Number);
    const tl = new Date(t + 5 * H), mins = tl.getUTCHours() * 60 + tl.getUTCMinutes(), today = tashDate(t);
    const last = await getKV(env, 'daily_sent');
    if (mins >= hh * 60 + mm && last !== today && await getKV(env, 'group')) { await setKV(env, 'daily_sent', today); await dailyReport(env, today); }
  }
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
