# Video Analysis Runtime

面向开发者的本地视频、音频、ASR 与 LLM 流水线运行时。

项目提供开放的资产、任务、媒体处理、ASR、LLM 和顺序 Pipeline API。服务不会注入产品业务提示词；调用方负责提供模型、messages 与输出 Schema。

## 能力

- 流式媒体上传与 HTTP(S) 媒体导入
- FFmpeg 探测、抽音轨与截帧
- 百炼、OpenAI 兼容及本地 faster-whisper ASR
- 开放的 OpenAI 兼容 LLM messages/JSON Schema
- 持久化异步任务与顺序流水线
- 可选抖音 Connector
- Windows Native Host 与四 Profile 安装器

## 开发

```powershell
cd server
copy .env.example .env
npm.cmd install
npm.cmd test
npm.cmd start
```

默认地址：`http://127.0.0.1:18765`。API 契约见 [server/openapi.yaml](server/openapi.yaml)。

## 发布 Profile

| Profile | 云端 ASR | 本地 ASR | 抖音 Connector |
|---|---:|---:|---:|
| `cloud` | ✓ |  |  |
| `hybrid` | ✓ | ✓ |  |
| `douyin-cloud` | ✓ |  | ✓ |
| `douyin-hybrid` | ✓ | ✓ | ✓ |

```powershell
npm.cmd run prepare:asr
npm.cmd run build:desktop -- --profile=hybrid
npm.cmd run build:installer -- --profile=hybrid
```

Douyin 安装器需要配置：

```powershell
$env:VIDEO_ANALYSIS_CHROME_EXTENSION_ID="扩展ID"
$env:VIDEO_ANALYSIS_EDGE_EXTENSION_ID="扩展ID"
```

推送 `v*` Tag 后，GitHub Actions 会自动生成四个 Windows x64 安装器和 SHA-256。
