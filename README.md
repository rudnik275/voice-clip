# telegram-speech-to-text

Telegram-бот на Bun + grammY + TypeScript. Принимает voice → транскрибирует через OpenAI (`gpt-4o-transcribe`) → кладёт текст в буфер обмена macOS → показывает уведомление.

## Сценарий

1. Отправляю voice в бот
2. Текст оказывается в буфере (`pbcopy`)
3. macOS-уведомление с результатом (terminal-notifier)
4. `Cmd+V` в любом приложении

## Требования

- macOS
- [Bun](https://bun.sh)
- [terminal-notifier](https://github.com/julienXX/terminal-notifier): `brew install terminal-notifier`
- [PM2](https://pm2.keymetrics.io) (для автозапуска): `npm i -g pm2`

## Setup

1. `bun install`
2. Создать бота через [@BotFather](https://t.me/BotFather), получить токен
3. Узнать свой Telegram user ID — например, через [@userinfobot](https://t.me/userinfobot)
4. `cp .env.example .env` и заполнить:
   - `TELEGRAM_BOT_TOKEN` — токен от BotFather
   - `OPENAI_API_KEY` — ключ OpenAI
   - `ALLOWED_USER_IDS` — числовые ID через запятую (whitelist)

## Запуск

Dev (без PM2):

```sh
bun run src/index.ts
```

Под PM2 (автоперезапуск + автостарт при логине):

```sh
bun run pm2:start
pm2 save
pm2 startup        # печатает sudo-команду — выполнить её вручную
```

Логи: `bun run pm2:logs`

## Out of scope

- Не отвечает на текстовые сообщения
- Никакой пост-обработки (GPT)
- Никакой истории/логов сообщений
- Long-polling, без публичного URL
