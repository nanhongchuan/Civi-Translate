# ASR 引擎切换

后端默认使用 `faster-whisper`。如果要试 NVIDIA Parakeet，先安装额外依赖：

```bash
npm run api:install:parakeet
```

启动 API 时设置引擎：

```bash
RT_ASR_ENGINE=parakeet npm run api
```

可选环境变量：

- `RT_ASR_ENGINE=faster_whisper|parakeet`
- `RT_ASR_MODEL=nvidia/parakeet-tdt-0.6b-v2`
- `RT_ASR_DEVICE=cpu|cuda|mps`

说明：

- `faster_whisper` 仍是默认引擎，适合本机兼容性和中英混合场景。
- `parakeet` 走 NVIDIA NeMo，默认模型是 `nvidia/parakeet-tdt-0.6b-v2`，更适合英文转写评估。
- 前端不直接加载模型；它通过 `/api/asr/ws` 收到后端返回的 `engine` 字段后显示当前引擎。
