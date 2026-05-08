# Civi Translate

[English](README.md) | [中文](README_zh-CN.md)

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/nanhongchuan/Liqun-Translate)

Civi Translate is a local-first realtime interpreting web app. It captures microphone audio in the browser, streams it to a local FastAPI service for ASR, then sends stable text segments through a user-configured OpenAI-compatible LLM endpoint for translation.

The current app is designed for desktop browser use on macOS/local development: React + Vite on the frontend, FastAPI on `127.0.0.1:18787` on the backend, and local configuration storage for ASR/LLM settings.

## Features

- Realtime microphone capture with a WebSocket ASR pipeline.
- Local ASR by default via `faster-whisper`, with optional NVIDIA Parakeet support.
- Optional online ASR adapter for OpenAI-style transcription APIs.
- OpenAI-compatible LLM translation proxy with local Base URL, API key, and model settings.
- Dual-pane session view for source transcript and translated text.
- Session history, favorite phrases, and Markdown export.
- Local backend storage for sensitive API settings instead of writing keys into frontend storage.

## Architecture

```text
Browser UI
  -> microphone audio
  -> /api/asr/ws on local FastAPI
  -> stable transcript segments
  -> /api/translate/stream or /api/translate
  -> user-configured OpenAI-compatible LLM endpoint
```

The backend only listens on localhost by default. ASR audio is processed locally unless you explicitly configure the online ASR engine. Translation text is sent to the LLM provider configured in Settings.

## Requirements

- Node.js 18+
- Python 3.11+
- macOS or another local desktop environment with microphone access
- An OpenAI-compatible LLM API endpoint for translation

For the default local ASR path, install Python dependencies from `backend/requirements.txt`. Parakeet uses a separate Python 3.12 environment managed by `uv`.

## Setup

Install frontend dependencies:

```bash
npm install
```

Install backend dependencies:

```bash
npm run api:install
```

Start frontend and backend together:

```bash
npm run dev:all
```

Then open the Vite URL printed by the terminal, usually:

```text
http://localhost:5173
```

The API health endpoint is available at:

```text
http://127.0.0.1:18787/api/health
```

## First Run

1. Open `http://localhost:5173`.
2. Go to Settings.
3. Configure the language model with Base URL, API key, and model.
4. Test and save the LLM settings.
5. Choose or install an ASR engine.
6. Start a live session and allow microphone access.

## Useful Commands

```bash
npm run dev              # Start only the Vite frontend
npm run api              # Start only the local FastAPI backend
npm run dev:all          # Start frontend and backend together
npm run build            # Type-check and build the frontend
npm run api:smoke        # Run backend smoke checks against the local API
npm run api:verify       # Health check plus translation smoke verification
```

## ASR Engines

Default engine:

```bash
npm run api
```

Parakeet setup:

```bash
npm run api:install:parakeet
npm run dev:all:parakeet
```

More details are in [`docs/asr-engines.md`](docs/asr-engines.md).

## Configuration

LLM settings are managed in the app UI under Settings. The backend supports:

- `vendor`
- `base_url`
- `model`
- `api_key`

The backend sends translation requests to:

```text
{base_url}/chat/completions
```

For local development, Vite proxies `/api/*` requests to the FastAPI service on `127.0.0.1:18787`.

## Project Structure

```text
src/                    React frontend
src/components/         App views and UI components
src/hooks/useLiveAsr.ts Browser microphone and ASR WebSocket flow
backend/app/            FastAPI app, ASR adapters, LLM proxy
backend/scripts/        Smoke-test utilities
docs/                   Product, UI, and ASR notes
```

## Notes

- API keys are stored by the local backend settings layer, not in browser localStorage.
- Microphone audio stays local when using the local ASR engines.
- Translation quality and latency depend on the configured upstream LLM endpoint.
- If `/api/health` succeeds but translation routes look stale, stop the old backend process and restart with `npm run api` or `npm run dev:all`.
