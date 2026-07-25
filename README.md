# 资料终端桌面版

一个 Windows 本地优先的文件夹助手：文件仍保留在原位置，应用用 SQLite 在本机保存索引、备注和标签，并将小型语言模型下载到应用自身的数据目录中运行。

## 已完成的桌面能力

- 选择本机文件夹，递归建立目录/文件索引，不复制、移动或删除原文件。
- SQLite 本地数据库保存文件夹引用和索引。
- 应用内下载 `llama.cpp` Windows CPU 运行时。
- 应用内下载 `Qwen2.5 1.5B Instruct Q4_K_M` GGUF 模型；下载进度显示在界面内。
- 模型和运行时准备完成时，内置 `llama-cli` 将自然语言问题转换为检索词，再用 SQLite 中的真实路径、标签、备注返回结果。
- 模型尚未下载时也有安全的本地规则兜底：例如“现在想要玩游戏”会检索 `游戏`、`game`、`steam` 相关的文件夹与文件。

## 隐私边界

- 默认索引数据库与模型位于 `%LOCALAPPDATA%\资料终端`。
- 文件夹仅被读取来建立索引；不会上传、移动、删除或改写任何原文件。
- 模型及运行时仅在你点击应用内下载按钮后下载。默认模型下载约 1 GB，运行时从 llama.cpp 官方 GitHub Releases 下载。

## 运行

开发模式：

```powershell
cd D:\DLOW\DM\TEST2\V16\file-terminal-desktop
npm install
npm run desktop:dev
```

已生成的 Windows 安装包：

`src-tauri\target\release\bundle\nsis\资料终端_0.1.1_x64-setup.exe`

## 自动更新

首次安装后，应用会从 GitHub Releases 检查新版本。发现更新时确认即可下载、安装并重启；SQLite 索引、备注、标签和已下载的模型仍留在 `%LOCALAPPDATA%\资料终端`，不会重复下载或丢失。

发布新版本时：

1. 同步更新 `package.json` 与 `src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 中的版本号。
2. 创建并推送形如 `v0.1.1` 的 Git 标签。
3. GitHub Actions 会构建签名安装包、发布 Release，并生成 `latest.json` 供已安装客户端自动更新。

发布工作流依赖仓库 Secret `TAURI_SIGNING_PRIVATE_KEY`。私钥绝不能提交到 Git；丢失后无法继续为既有客户端签名更新。

## 验证

```powershell
npm test
npm run build
cd src-tauri
cargo test
cargo check
```

## 当前限制

- 当前首版索引文件名、完整路径、文件夹备注和标签；文档正文提取与向量检索属于下一阶段。
- 当前运行时下载固定 CPU x64 Windows 构建。GPU 加速、断点续传、模型更新校验和多模型选择可在后续补充。
- 当前使用已验证的 llama.cpp Windows CPU x64 发布包；正式发布前仍应增加镜像、自动版本清单和 SHA-256 校验。
