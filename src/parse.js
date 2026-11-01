// Распознавание заявки на бронь из свободного текста клиента.
// Понимает разные варианты: нумерованную форму, подписи «Имя:», разброс полей,
// русские и узбекские (латиница) слова, телефоны в любом формате.

const MONTHS = [
  [/^(янв|yanv)/, 1], [/^(фев|fev)/, 2], [/^(мар|mart)/, 3], [/^(апр|apr)/, 4], [/^(ма[йя]|may)/, 5], [/^(июн|iyun)/, 6],
  [/^(июл|iyul)/, 7], [/^(авг|avg)/, 8], [/^(сен|sen)/, 9], [/^(окт|okt)/, 10], [/^(ноя|noy)/, 11], [/^(дек|dek)/, 12]
];
const WEEKDAYS = [[/^(воскр|yakshan)/, 0], [/^(понед|dushan)/, 1], [/^(вторн|seshan)/, 2], [/^(сред|chorshan)/, 3], [/^(четв|payshan)/, 4], [/^(пятн|juma)/, 5], [/^(суббот|shanba)/, 6]];
const QUEST_ALIASES = [
  [/hell|хел+[\s-]*х[ао]ус|хэл+|хелл|(?:^|[^a-z])hh2?(?![a-z])/i, 'Hell House 2'],
  [/катаком|catacomb|katakom/i, 'Катакомбы'],
  [/подзем|podzem|dungeon/i, 'Подземелье'],
  [/бабуш|каникул|babush|kanikul|бабк/i, 'Каникулы бабушки']
];
const NAME_STOP = /(salom|хотели|хотел|подскаж|скажите|пожалуйста|iltimos|rahmat|чел|человек|игрок|kishi|odam|завтра|сегодня|послезавтра|ertaga|bugun|квест|бронь|брон|хотим|хочу|можно|здравст|привет|салам|assalom|добрый|время|дата|телефон|номер|имя|спасибо|утра|вечера|дня|ночи|час|минут|предоплат|оплат|скидк)/i;

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// Ищем в тексте ответы по пунктам нашей формы:
// 1 телефон, 2 имя, 3 кол-во игроков, 4 дата и время, 5 квест.
// Строки-подсказки из шаблона («1: Номер телефона») пропускаем.
const LABELS = [null, /номер\s*телефона|телефон|номер|tel/i, /ваше\s*имя|имя|ism/i, /количество\s*игроков|кол-?во\s*игроков|количество|игроков|kishi/i, /дата\s*и\s*время|дата|время|sana|vaqt/i, /название\s*квеста|квест|kvest/i];
function numberedBlock(text) {
  const lines = text.split(/\n/);
  let best = null, cur = null;
  const close = () => { if (cur && Object.keys(cur).filter(k => k !== '_lines').length >= 3) best = cur; cur = null; };
  for (const raw of lines) {
    const m = raw.match(/^\s*([1-5])(?:\s*[.):\-–]\s*|\s+)(.+)$/);
    if (!m) { if (raw.trim() && cur) close(); continue; }
    const n = +m[1];
    let v = m[2].trim();
    const lab = v.match(LABELS[n]);
    if (lab && lab.index === 0) v = v.slice(lab[0].length).replace(/^[\s:\-–—=]+/, '').trim(); // «Номер телефона: 90...» → «90...»
    if (cur && n <= Math.max(...Object.keys(cur).filter(k => k !== '_lines').map(Number))) close();
    cur = cur || { _lines: [] };
    cur._lines.push(raw);
    if (v) cur[n] = v;
  }
  close();
  return best;
}

// today — 'YYYY-MM-DD' по Ташкенту
export function parseBooking(text, opts = {}) {
  const block = !opts._inner && numberedBlock(text || '');
  if (block) {
    const inner = t => parseBooking(t, { ...opts, _inner: true }).fields;
    const f = {};
    if (block[1]) { const p = inner(block[1]).phone; if (p) f.phone = p; }
    if (block[2]) { const n = block[2].replace(/[^A-Za-zА-Яа-яЁёЎўҚқҒғҲҳʻ'\-\s]/g, ' ').replace(/\s+/g, ' ').trim(); if (n) f.name = n.slice(0, 40).split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' '); }
    if (block[3]) { const g = inner(/^\d{1,2}\s*$/.test(block[3]) ? block[3] + ' чел' : block[3]); if (g.guests) { f.guests = g.guests; if (g.guestsText) f.guestsText = g.guestsText; } }
    if (block[4]) { const d = inner(block[4]); if (d.date) f.date = d.date; if (d.time) f.time = d.time; }
    if (block[5]) { const q = inner(block[5]).quest; if (q) f.quest = q; else f.questRaw = block[5]; }
    // остальной текст (вне пунктов): дату часто пишут сверху над формой
    let outside = text; for (const l of block._lines) outside = outside.replace(l, ' ');
    const o = inner(outside);
    if (!f.date && o.date) f.date = o.date;
    if (!f.time && o.time) f.time = o.time;
    if (!f.phone && o.phone) f.phone = o.phone;
    if (!f.quest && o.quest) f.quest = o.quest;
    const res = { fields: f, missing: ['quest', 'date', 'time', 'name', 'phone'].filter(k => !f[k]), form: true };
    res.score = (f.phone ? 2 : 0) + (f.date ? 1 : 0) + (f.time ? 1 : 0) + (f.quest ? 1 : 0) + (f.guests ? 1 : 0) + (f.name ? 0.5 : 0);
    res.isBooking = res.score >= 2.5;
    return res;
  }
  const { today, quests = [] } = opts;
  const res = { fields: {}, score: 0, missing: [] };
  if (!text || typeof text !== 'string') return res;
  const base = today ? new Date(today + 'T00:00:00Z') : new Date();
  const f = res.fields;
  const lines = text.split(/\n+/).map(l => l.replace(/^\s*\d{1,2}\s*[.)]\s+/, '').trim()).filter(Boolean);
  const all = lines.join('\n');
  const used = new Set(); // куски текста, уже ставшие полями

  // --- Телефон
  for (const m of all.matchAll(/\+?\d[\d\s\-()]{7,17}\d/g)) {
    const d = m[0].replace(/\D/g, '');
    let ph = null;
    if (d.length === 9) ph = '+998' + d;
    else if (d.length === 12 && d.startsWith('998')) ph = '+' + d;
    else if (d.length === 11 && d.startsWith('8')) ph = '+7' + d.slice(1);
    else if (d.length === 11 && d.startsWith('7')) ph = '+' + d;
    if (ph) { f.phone = ph; used.add(m[0]); break; }
  }
  let rest = all; for (const u of used) rest = rest.replace(u, ' ');

  // --- Дата
  const setDate = (day, month, year) => {
    if (day < 1 || day > 31 || month < 1 || month > 12) return false;
    let y = year || base.getUTCFullYear();
    let d = new Date(Date.UTC(y, month - 1, day));
    if (!year && d < new Date(base.getTime() - 60 * 86400e3)) d = new Date(Date.UTC(y + 1, month - 1, day)); // давно прошло (напр. «5 января» в декабре) — следующий год
    f.date = ymd(d); return true;
  };
  let m;
  for (const mm of rest.matchAll(/(\d{1,2})\s*(?:-?го)?\s+([а-яёa-z]{3,})/gi)) {
    const mon = MONTHS.find(([re]) => re.test(mm[2].toLowerCase()));
    if (mon && setDate(+mm[1], mon[1])) { rest = rest.replace(mm[0], ' '); break; }
  }
  if (!f.date) {
    for (const mm of rest.matchAll(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/g)) {
      const a = +mm[1], b = +mm[2];
      if (!mm[3] && (b === 0 || b > 12)) continue; // это время вида 17.00 / 10.30
      if (setDate(a, b, mm[3] ? (mm[3].length === 2 ? 2000 + +mm[3] : +mm[3]) : 0)) { rest = rest.replace(mm[0], ' '); break; }
    }
  }
  if (!f.date) {
    const low = rest.toLowerCase();
    const rel = [[/послезавтра|indinga/, 2], [/завтра|ertaga/, 1], [/сегодня|bugun/, 0]].find(([re]) => re.test(low));
    if (rel) { f.date = ymd(new Date(base.getTime() + rel[1] * 86400e3)); }
    else {
      for (const w of low.split(/[^а-яёa-z]+/)) {
        const wd = WEEKDAYS.find(([re]) => re.test(w));
        if (wd) { let diff = (wd[1] - base.getUTCDay() + 7) % 7; f.date = ymd(new Date(base.getTime() + diff * 86400e3)); break; }
      }
    }
  }

  // --- Время
  const setTime = (h, mi = 0, ctx = '') => {
    if (/вечер|kech|ночи|дня|tushdan/i.test(ctx) && h < 12) h += 12;
    if (h < 0 || h > 23 || mi < 0 || mi > 59) return false;
    if (h < 8 && !/утра|ertalab/i.test(ctx)) h += 12; // «к 5» — скорее 17:00
    f.time = `${pad(h)}:${pad(mi)}`; return true;
  };
  if ((m = rest.match(/\b(\d{1,2})[:.](\d{2})\b(\s*(?:утра|вечера|дня|ночи))?/i)) && setTime(+m[1], +m[2], m[3] || '')) rest = rest.replace(m[0], ' ');
  else if ((m = rest.match(/(?:(?:^|[\s,.(])(?:к|в|на|at|soat)\s+)(\d{1,2})(?:\s*(?:ч|час[а-я]*|00))?(\s*(?:утра|вечера|дня|ночи))?(?![\d.\-–:])/i)) && setTime(+m[1], 0, m[2] || '')) rest = rest.replace(m[0], ' ');
  else if ((m = rest.match(/\b(\d{1,2})\s*(?:ч\b|час|soat)(\s*(?:утра|вечера|дня|ночи))?/i)) && setTime(+m[1], 0, m[2] || '')) rest = rest.replace(m[0], ' ');

  // --- Количество игроков
  if ((m = rest.match(/(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*(?:чел\S*|игрок\S*|kishi|odam|пер\S*)?/i)) && +m[2] <= 40 && +m[1] < +m[2]) {
    f.guests = +m[2]; f.guestsText = `${m[1]}–${m[2]}`; rest = rest.replace(m[0], ' ');
  } else if ((m = rest.match(/(\d{1,2})\s*(?:чел\S*|игрок\S*|kishi|odam|персон\S*)/i)) && +m[1] <= 40) {
    f.guests = +m[1]; rest = rest.replace(m[0], ' ');
  } else if ((m = rest.match(/(?:кол-?во|количеств\S*|участник\S*)[^\d\n]{0,15}(\d{1,2})/i)) && +m[1] <= 40) { f.guests = +m[1]; rest = rest.replace(m[0], ' ');
  } else if ((m = rest.match(/(?:нас|biz)\s+(\d{1,2})/i))) { f.guests = +m[1]; rest = rest.replace(m[0], ' '); }
  else {
    const lone = rest.split('\n').map(s => s.trim()).find(s => /^\d{1,2}$/.test(s) && +s >= 2 && +s <= 40);
    if (lone) { f.guests = +lone; rest = rest.replace(lone, ' '); }
  }

  // --- Квест
  const qnames = quests.map(q => q.name || q);
  for (const [re, name] of QUEST_ALIASES) if (re.test(all)) { f.quest = qnames.find(n => n.toLowerCase() === name.toLowerCase()) || name; break; }
  if (!f.quest) for (const n of qnames) {
    const key = n.toLowerCase().split(/\s+/).find(w => w.length > 3);
    if (key && all.toLowerCase().includes(key.slice(0, 5))) { f.quest = n; break; }
  }

  // --- Имя
  if ((m = all.match(/(?:имя|name|ism|меня зовут|зовут)[ \t]*[:\-—]?[ \t]*([A-Za-zА-Яа-яЁёЎўҚқҒғҲҳʻ'\-]{2,20}(?:[ \t]+[A-Za-zА-Яа-яЁёЎўҚқҒғҲҳʻ'\-]{2,20})?)/i))) f.name = m[1].trim();
  if (!f.name) {
    for (const l of rest.split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
      const s = l.replace(/^[^:]{0,15}:\s*/, '').trim();
      if (/^[A-Za-zА-Яа-яЁёЎўҚқҒғҲҳʻ'\-]{2,20}(\s+[A-Za-zА-Яа-яЁёЎўҚқҒғҲҳʻ'\-]{2,20}){0,2}$/.test(s) && !NAME_STOP.test(s)
        && !QUEST_ALIASES.some(([re]) => re.test(s)) && !MONTHS.some(([re]) => s.toLowerCase().split(/\s+/).some(w => re.test(w)))
        && !WEEKDAYS.some(([re]) => re.test(s.toLowerCase()))) { f.name = s.split(/\s+/).map(w => w[0].toUpperCase() + w.slice(1)).join(' '); break; }
    }
  }

  if (!f.name) { // имя внутри фразы: слово с большой буквы, не первое в тексте
    const words = rest.match(/[A-ZА-ЯЁЎҚҒҲ][a-zа-яёўқғҳʻ']{2,19}/g) || [];
    const cand = words.filter((w, i) => !NAME_STOP.test(w) && !/^(salom|hello|hi|здрав|добр|good)/i.test(w) && !QUEST_ALIASES.some(([re]) => re.test(w))
      && !MONTHS.some(([re]) => re.test(w.toLowerCase())) && !WEEKDAYS.some(([re]) => re.test(w.toLowerCase())) && rest.trim().indexOf(w) !== 0);
    if (cand.length) f.name = cand[cand.length - 1];
  }

  // --- Оценка: похоже ли это на заявку
  res.score = (f.phone ? 2 : 0) + (f.date ? 1 : 0) + (f.time ? 1 : 0) + (f.quest ? 1 : 0) + (f.guests ? 1 : 0) + (f.name ? 0.5 : 0);
  for (const k of ['quest', 'date', 'time', 'name', 'phone']) if (!f[k]) res.missing.push(k);
  res.isBooking = res.score >= 3 && [f.date, f.time, f.quest, f.guests].filter(Boolean).length >= 2;
  return res;
}
