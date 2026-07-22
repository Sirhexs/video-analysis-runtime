# Video Analysis Runtime

Video Analysis Runtime 是一个面向开发者的本地媒体分析运行时，提供资产管理、FFmpeg、ASR、LLM 调用、顺序 Pipeline 和可选站点 Connector API。

服务不会注入具体产品的业务提示词。调用方负责提供模型配置、`messages`、JSON Schema 和分析流程，因此它既可以配合 BrowseLife 使用，也可以作为独立的本地视频分析基础设施。

> 当前桌面安装器主要面向 Windows x64。Runtime API 和打包 Profile 仍可能随开发继续调整。

## 核心能力

- 流式上传媒体，或从 HTTP(S) URL 导入媒体资产
- 使用 FFmpeg 探测媒体、抽取音轨和截取关键帧
- 支持百炼、OpenAI 兼容和本地 faster-whisper ASR
- 转发调用方提供的 OpenAI 兼容 LLM `messages`
- 支持 JSON Schema、显式修复请求和顺序 Pipeline
- 持久化异步任务、任务取消、资产清理和服务重启恢复
- 可选抖音媒体 Connector
- Windows Native Messaging Host 与四种桌面安装 Profile

## 与 BrowseLife 的关系

```text
BrowseLife Extension
       │ Runtime API / Native Messaging
       ▼
Video Analysis Runtime
       ├── Media / FFmpeg
       ├── Cloud or Local ASR
       ├── LLM / Pipeline
       └── Optional Douyin Connector
```

BrowseLife 负责浏览记录、统计、任务编排和结果展示；Runtime 负责媒体下载、音视频处理、ASR 和模型调用。两个项目可以独立开发和发布。

## 环境要求

### 运行源码服务

- Node.js 18 或更高版本，推荐 Node.js 22
- npm
- FFmpeg 与 FFprobe，可通过 PATH 或环境变量指定

### 构建 Windows 安装器

- Windows x64
- Node.js 22
- Rust stable toolchain
- FFmpeg 与 FFprobe
- Inno Setup 6
- Python 3.11、PyInstaller 和 faster-whisper（仅 Hybrid Profile）
- `Systran/faster-whisper-small` 模型（仅 Hybrid Profile）

GitHub Actions 会自动准备以上构建依赖。

## 快速开始

```powershell
git clone <your-video-analysis-runtime-repository-url>
cd video-analysis-runtime\server
Copy-Item .env.example .env
npm ci
npm test
npm start
```

默认地址为 `http://127.0.0.1:18765`，默认开发 Profile 为 `cloud`。完整环境变量示例见 [server/.env.example](server/.env.example)。

生产或共享环境中应设置鉴权 Token：

```env
RUNTIME_AUTH_TOKEN=replace-with-a-random-secret
```

请求使用：

```http
Authorization: Bearer <RUNTIME_AUTH_TOKEN>
```

## API

完整 OpenAPI 契约见 [server/openapi.yaml](server/openapi.yaml)。主要端点包括：

| 端点 | 用途 |
|---|---|
| `GET /health` | 健康状态、版本、Profile 和本地 ASR 状态 |
| `GET /v1/capabilities` | 查询可用能力与 Operation |
| `POST /v1/assets` | 上传媒体流或通过 JSON URL 导入媒体 |
| `GET /v1/assets/:id` | 获取资产信息 |
| `DELETE /v1/assets/:id` | 删除资产 |
| `POST /v1/jobs` | 创建异步任务 |
| `GET /v1/jobs/:id` | 查询任务状态与结果 |
| `POST /v1/jobs/:id/cancel` | 取消任务 |

主要 Operation：

- `media.probe`
- `media.extract_audio`
- `media.extract_frames`
- `asr.transcribe`
- `llm.generate`
- `video.analyze`
- `connector.douyin.import`
- `pipeline.run`

`llm.generate` 会转发调用方提供的 `messages`。只有显式设置 `repairAttempts` 时，Runtime 才会按照调用方提供的 JSON Schema 发起修复请求。

## 发布 Profile

| Profile | 云端 ASR | 本地 ASR | 抖音 Connector | 适用场景 |
|---|---:|---:|---:|---|
| `cloud` | ✓ |  |  | 通用媒体与云端模型服务 |
| `hybrid` | ✓ | ✓ |  | 通用媒体与本机 ASR |
| `douyin-cloud` | ✓ |  | ✓ | BrowseLife + 云端 ASR |
| `douyin-hybrid` | ✓ | ✓ | ✓ | BrowseLife + 本机/云端 ASR |

## 本地构建

先安装服务依赖：

```powershell
npm.cmd --prefix server ci
```

构建 Cloud Profile：

```powershell
npm.cmd run build:desktop -- --profile=cloud
npm.cmd run build:installer -- --profile=cloud
```

构建 Hybrid Profile 前，需要创建 Python 环境、安装 ASR 构建依赖并准备模型：

```powershell
python -m venv server/asr/.venv
server/asr/.venv/Scripts/python.exe -m pip install -r server/asr/requirements.txt -r server/asr/requirements-build.txt
server/asr/.venv/Scripts/python.exe -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='Systran/faster-whisper-small', local_dir='dist/model-small')"
node tools/build-asr-bundle.mjs --model-dir=dist/model-small
npm.cmd run test:asr-bundle
```

然后构建目标 Profile：

```powershell
npm.cmd run build:desktop -- --profile=hybrid
npm.cmd run build:installer -- --profile=hybrid
npm.cmd run test:desktop -- --profile=hybrid
```

安装器和校验文件输出到 `dist/installer/`。

## BrowseLife 扩展 ID

包含抖音 Connector 的安装器需要把 BrowseLife 扩展 ID 写入 Native Messaging `allowed_origins`：

```powershell
$env:VIDEO_ANALYSIS_CHROME_EXTENSION_ID="nfiieinehobmaofhodfaccgjboegcdck"
$env:VIDEO_ANALYSIS_EDGE_EXTENSION_ID="nfiieinehobmaofhodfaccgjboegcdck"
```

该 ID 由 BrowseLife manifest 中的固定公开公钥生成。更换 BrowseLife 公钥后，必须同步更新以上 ID 并重新构建 Runtime 安装器。

## GitHub Actions 自动发布

[Release Video Analysis Runtime](.github/workflows/release-runtime.yml) 支持手动运行和 `v*` Tag：

1. 验证 Tag 与根 `package.json` 版本一致。
2. 运行服务端测试与 Native Host Rust 检查。
3. 使用 Python 3.11 构建并缓存本地 ASR Bundle。
4. 并行构建四种 Windows x64 Profile。
5. 执行桌面 Profile 冒烟测试。
6. 上传包含安装器和 SHA-256 校验文件的 Actions Artifact。
7. Tag 触发时创建 GitHub Release，并仅发布安装器文件。

发布 `1.0.1` 的示例：

```powershell
git tag v1.0.1
git push origin v1.0.1
```

手动运行工作流只生成 Artifacts，不创建 GitHub Release。Tag 必须采用 `v<package.json version>` 格式。

## 数据与配置

源码服务默认使用：

- `server/data/`：资产与任务状态
- `server/logs/`：运行日志
- `server/.env`：本机环境配置

桌面安装版本默认使用 `%LOCALAPPDATA%\VideoAnalysisRuntime`。任务和资产默认保留 24 小时，可通过环境变量调整。

## 项目结构

```text
server/          Runtime HTTP API、Operations、任务与资产管理
  asr/           本地 faster-whisper Runner 源码和依赖
  src/           服务实现
  test/          Node.js 测试
native-host/     Rust Native Messaging Host
installer/       Inno Setup 安装器与注册脚本
profiles/        四种发行 Profile 清单
tools/           ASR、桌面包、安装器与冒烟测试脚本
.github/         GitHub Actions 发布工作流
```

## 安全说明

- 服务默认监听 `127.0.0.1`；不要在未配置鉴权的情况下暴露到局域网或公网。
- 不要提交 `.env`、API Key、Cookie、Runtime Token、模型凭据或用户媒体。
- Douyin Cookie 只应提供给可信的本机 Runtime。
- Native Messaging 只允许显式配置的扩展 Origin。
- 桌面安装器仍会生成 SHA-256 文件，并保留在 Actions Artifact 中用于内部校验；GitHub Release 仅发布安装器。

## 参与贡献

欢迎通过 Issue 报告问题或讨论新的 Operation、Provider 和 Connector。提交 Pull Request 前请至少运行：

```powershell
npm.cmd --prefix server ci
npm.cmd --prefix server test
cargo check --locked --manifest-path native-host/Cargo.toml
```

涉及桌面分发的修改，还应构建对应 Profile 并运行 `tools/test-desktop-smoke.mjs`。

## 许可证

本项目采用 [MIT License](LICENSE)。
