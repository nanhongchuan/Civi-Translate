# Civi Translate

[English](README.md) | [中文](README_zh-CN.md)

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/nanhongchuan/Liqun-Translate)

Civi Translate 是一个本地优先的实时同传 Web 应用。它在浏览器中采集麦克风音频，通过本机 FastAPI 服务完成语音识别（ASR），再将稳定的文本片段发送到用户配置的 OpenAI 兼容 LLM 端点进行翻译。

当前版本面向本地桌面浏览器使用：前端基于 React + Vite，后端基于 FastAPI 并默认监听 `127.0.0.1:18787`，ASR 与 LLM 配置由本机后端保存。

## 功能特性

- 基于 WebSocket 的实时麦克风采集与 ASR 流水线。
- 默认支持本机 `faster-whisper` 语音识别，可选 NVIDIA Parakeet。
- 支持 OpenAI 风格转写 API 的在线 ASR 适配器。
- OpenAI 兼容 LLM 翻译代理，可配置 Base URL、API Key 和模型。
- 双栏会话视图，分别展示原文转写与译文。
- 支持历史记录、收藏短语和 Markdown 导出。
- 敏感 API 配置由本机后端保存，不写入前端 localStorage。

## 架构

```text
浏览器界面
  -> 麦克风音频
  -> 本机 FastAPI /api/asr/ws
  -> 稳定转写片段
  -> /api/translate/stream 或 /api/translate
  -> 用户配置的 OpenAI 兼容 LLM 端点
```

后端默认只监听 localhost。使用本地 ASR 引擎时，麦克风音频不会出网；只有翻译文本会发送到你在设置中配置的 LLM 服务。如果显式启用在线 ASR，则转写音频会按该服务配置发送到对应端点。

## 环境要求

- Node.js 18+
- Python 3.11+
- macOS 或其他支持麦克风访问的本地桌面环境
- 一个用于翻译的 OpenAI 兼容 LLM API 端点

默认本地 ASR 路径需要安装 `backend/requirements.txt` 中的 Python 依赖。Parakeet 使用由 `uv` 管理的独立 Python 3.12 环境。

## 安装与启动

安装前端依赖：

```bash
npm install
```

安装后端依赖：

```bash
npm run api:install
```

同时启动前端和后端：

```bash
npm run dev:all
```

然后打开终端输出的 Vite 地址，通常是：

```text
http://localhost:5173
```

后端健康检查地址：

```text
http://127.0.0.1:18787/api/health
```

## 首次使用

1. 打开 `http://localhost:5173`。
2. 进入设置页。
3. 配置语言模型的 Base URL、API Key 和模型。
4. 测试并保存 LLM 配置。
5. 选择或安装 ASR 引擎。
6. 开始会话，并允许浏览器访问麦克风。

## 常用命令

```bash
npm run dev              # 只启动 Vite 前端
npm run api              # 只启动本机 FastAPI 后端
npm run dev:all          # 同时启动前端和后端
npm run build            # 类型检查并构建前端
npm run api:smoke        # 对本机 API 执行冒烟检查
npm run api:verify       # 健康检查 + 翻译冒烟验证
```

## ASR 引擎

默认引擎：

```bash
npm run api
```

Parakeet 安装与启动：

```bash
npm run api:install:parakeet
npm run dev:all:parakeet
```

更多说明见 [`docs/asr-engines.md`](docs/asr-engines.md)。

## 配置

LLM 配置在应用的设置页中管理。后端支持：

- `vendor`
- `base_url`
- `model`
- `api_key`

后端会将翻译请求发送到：

```text
{base_url}/chat/completions
```

本地开发时，Vite 会把 `/api/*` 请求代理到 `127.0.0.1:18787` 上的 FastAPI 服务。

## 项目结构

```text
src/                    React 前端
src/components/         应用视图与 UI 组件
src/hooks/useLiveAsr.ts 浏览器麦克风与 ASR WebSocket 流程
backend/app/            FastAPI 应用、ASR 适配器、LLM 代理
backend/scripts/        冒烟测试脚本
docs/                   产品、UI 与 ASR 说明文档
```

## 说明

- API Key 由本机后端设置层保存，不写入浏览器 localStorage。
- 使用本地 ASR 引擎时，麦克风音频保留在本机处理。
- 翻译质量和延迟取决于你配置的上游 LLM 端点。
- 如果 `/api/health` 正常但翻译路由表现像旧版本，结束旧后端进程后用 `npm run api` 或 `npm run dev:all` 重新启动。
