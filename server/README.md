# Video Analysis Runtime

面向开发者的本地媒体分析基础设施。服务提供资产、FFmpeg、ASR、开放 LLM 调用和顺序流水线 API，不注入产品业务提示词。

## 启动

```powershell
copy .env.example .env
npm.cmd install
npm.cmd start
```

默认地址为 `http://127.0.0.1:18765`。开发源码默认使用 `cloud` Profile；需要抖音 Connector 时设置：

```env
RUNTIME_PROFILE=douyin-hybrid
```

## API

- `GET /health`
- `GET /v1/capabilities`
- `POST /v1/assets`：原始媒体流，文件名通过 `X-Filename` 指定；JSON `{ "url": "https://..." }` 导入媒体 URL
- `GET/DELETE /v1/assets/:id`
- `POST /v1/jobs`
- `GET /v1/jobs/:id`
- `POST /v1/jobs/:id/cancel`

鉴权使用 `Authorization: Bearer <RUNTIME_AUTH_TOKEN>`。完整契约见 [openapi.yaml](openapi.yaml)。

原子 Operation：

- `media.probe`
- `media.extract_audio`
- `media.extract_frames`
- `asr.transcribe`
- `llm.generate`
- `video.analyze`
- `connector.douyin.import`
- `pipeline.run`

`llm.generate` 会原样转发调用方提供的 `messages`。只有显式提供 `repairAttempts` 时，服务才会根据调用方的 JSON Schema 发起修复请求。

## 发布 Profile

| Profile | 云端 ASR | 本地 ASR | 抖音 Connector |
|---|---:|---:|---:|
| `cloud` | ✓ |  |  |
| `hybrid` | ✓ | ✓ |  |
| `douyin-cloud` | ✓ |  | ✓ |
| `douyin-hybrid` | ✓ | ✓ | ✓ |

```powershell
node tools/build-desktop.mjs --profile=cloud
node tools/build-installer.mjs --profile=cloud
```

任务和资产默认保留24小时。任务状态持久化到 `DATA_DIR/jobs`；服务重启时，未完成任务会标记为 `service_restarted`。
