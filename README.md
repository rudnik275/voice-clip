# voice-clip

Self-hosted voice → text → clipboard. Запускается на Маке. С айфона открывается как PWA с одной большой кнопкой Record. Записал → транскрипция через OpenAI `gpt-4o-transcribe` → текст летит **в буфер обмена айфона** (через браузер) **и в буфер обмена Мака** (через `pbcopy`) одновременно.

## Сценарий

1. Айфон лежит на столе. Открываешь PWA с домашнего экрана (или Safari).
2. Тап по большой кнопке → запись. Тап ещё раз → стоп.
3. На айфоне в textarea появляется текст и копируется в буфер айфона.
4. На Маке тот же текст оказывается в буфере (pbcopy).
5. Cmd+V на Маке или paste на айфоне — где надо.

## Требования

- macOS
- [Bun](https://bun.sh)
- [Homebrew](https://brew.sh) — для mkcert
- iPhone и Mac в одной wifi
- [PM2](https://pm2.keymetrics.io) (опционально, для автозапуска): `npm i -g pm2`

## Setup

```sh
bun install
brew install mkcert nss
cp .env.example .env   # вписать OPENAI_API_KEY
bun run cert            # генерит сертификат для <mac-name>.local
```

`bun run cert` выведет инструкцию: какой файл переслать на айфон (rootCA от mkcert) и где его доверить в Settings. Это разовая возня — потом сертификат остаётся валидным.

## Запуск

Dev:

```sh
bun run dev
```

Под PM2 (автозапуск при логине):

```sh
bun run pm2:start
pm2 save
pm2 startup        # печатает sudo-команду — выполнить её вручную
```

Логи: `bun run pm2:logs`

## Айфон как PWA

1. На айфоне открыть `https://<mac-name>.local:8443`. `<mac-name>` смотри в System Settings → General → Sharing → Local hostname.
2. Дать разрешение на микрофон.
3. Share → **Add to Home Screen**. Иконка запускает страницу в полноэкранном режиме без UI Safari.

## Логи и автоочистка

- Записи: `data/recordings/YYYY-MM-DD_HH-mm-ss_xxx.m4a`
- Транскрипты: `data/transcripts/YYYY-MM-DD_HH-mm-ss_xxx.txt`
- На каждый upload: если последняя очистка была не сегодня — удаляются все файлы с датой не сегодняшней. Дата последней очистки лежит в `data/.last-cleanup`.
- Папка `data/` в `.gitignore`.

## Конфиг

Все переменные опциональны кроме `OPENAI_API_KEY`. Дефолты:

| Var             | Default                 |
| --------------- | ----------------------- |
| `PORT`          | `8443`                  |
| `TLS_CERT_PATH` | `./certs/cert.pem`      |
| `TLS_KEY_PATH`  | `./certs/key.pem`       |
| `DATA_DIR`      | `./data`                |

## Безопасность

- Без auth. Сервер слушает на всех интерфейсах в локальной сети — кто угодно в твоей wifi может постучать. Если это волнует — добавь токен в URL.
- Никакой публичной экспозиции наружу.

## Out of scope

- Никакой пост-обработки текста (GPT-исправлений и т.п.)
- Никакой истории кроме суточного лога
- Только iOS Safari как клиент проверен; Android Chrome скорее всего тоже работает, но не тестировался
