# QuestHouse — Telegram Mini App

Бот: [@QuestHouseBookingBot](https://t.me/QuestHouseBookingBot) · приложение: https://app.questhouse-uz.workers.dev

- **Брони** — сетка 11:00–22:00 по квестам, бронь в 1 клик, скидки, статусы, предоплата.
- **Касса** — отчёты по дням/месяцу: актёры, управление (Данил 10%, Амир 5%), остаток.
- **Видео** — задачи монтажёру с таймером сдачи и напоминаниями в Telegram.
- **Сотрудники** — первый вошедший становится владельцем, остальных он одобряет (Админ / Монтаж).

## Устройство
- `public/index.html` — само приложение (один файл).
- `src/worker.js` — сервер на Cloudflare Workers: API, проверка подписи Telegram, вебхук бота, cron-напоминания.
- `schema.sql` — таблицы базы D1.
- `wrangler.toml` — настройки деплоя.

Деплой: `CLOUDFLARE_API_TOKEN=... npx wrangler deploy`. Секреты `BOT_TOKEN` и `WEBHOOK_SECRET` хранятся в Cloudflare, не в репозитории.
