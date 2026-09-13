# 双子代理转子 · Gemini Proxy Rotator

> 多账号智能轮换 | 双模型独立优选分流 | 极客仪表盘

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/Platform-Windows-blue)](https://github.com/ygwbl/Gemin-Proxy-Rotator)

---

## 📸 界面预览

![仪表盘全览](docs/screenshot1.png)

---

## ✨ 核心功能

| 功能 | 说明 |
|------|------|
| 💻 反重力客户端原生换号 | 仪表盘一键直写 Windows 凭据管理器，反重力 IDE 重启即生效无需代理 |
| 🛡️ 虚拟设备指纹隔离 | 为每个账号自动绑定独立的 machineId/macMachineId，物理级切断风控连坐 |
| 🔌 Anthropic 原生协议 | 原生支持 `/v1/messages`，无缝接入 Claude Code CLI 与 SDK 深度思考链 |
| 🔀 智能重定向与任务降级 | 通配 GPT/Claude 家族模型，智能拦截后台标题生成降级 Flash，死守 Claude 额度 |
| 🧠 双模型独立优选分流 | Gemini → 配额最高账号；Claude → 配额最高账号，200% 产能压榨 |
| 📊 极客仪表盘 | 配额水位、健康分、冷却倒计时、延时雷达，实时一屏掌控 |
| ⏳ 冷却动态倒计时 | 动态跳动倒计时，归零瞬间自动微探测激活 |
| 📡 延时雷达 | 最近 5 次 RTT 均值与波动曲线，哪个账号延迟低一目了然 |
| 📈 Token/USD 看板 | 今日 Token 吞吐、商业 API 节省金额、请求成功率 |
| 🛡️ 防封护栏 | 单账号达 300 次/日自动休眠轮换，规避 Google 风控降权 |
| 💾 备份/恢复 | 账号配置一键导出导入，换机无痛迁移 |

---

## 🚀 快速开始（3 步上手）

### 前置条件
- Windows 系统
- [Node.js](https://nodejs.org) >= 18
- 已有 Google 账号（登录过 Cursor / Gemini / 反重力）

### 第一步：克隆仓库
```bash
git clone https://github.com/ygwbl/Gemin-Proxy-Rotator.git
cd Gemin-Proxy-Rotator
```

### 第二步：一键安装
双击运行 `install.bat`，脚本会自动：
1. 检测并安装 `tuxevil-rotator`
2. 注入极客仪表盘 UI
3. 注入客户端原生换号与虚拟指纹隔离模块
4. 替换双模型分流、Anthropic 协议与模型路由核心补丁

### 第三步：启动代理
```bash
tuxevil-rotator start
```
浏览器打开 **http://localhost:51200** 即可看到仪表盘。

---

## 🔧 手动安装（可选）

```powershell
# 1. 安装基础依赖
npm install -g tuxevil-rotator

# 2. 获取 npm 全局路径
$npmRoot = npm root -g

# 3. 替换仪表盘 UI
Copy-Item src\static\gemini-dashboard.html "$npmRoot\tuxevil-rotator\src\static\gemini-dashboard.html" -Force

# 4. 注入客户端换号与设备隔离模块
Copy-Item src\client-sync.ts "$npmRoot\tuxevil-rotator\src\client-sync.ts" -Force

# 5. 替换核心补丁
Copy-Item patches\proxy.ts "$npmRoot\tuxevil-rotator\src\proxy.ts" -Force
Copy-Item patches\compat.ts "$npmRoot\tuxevil-rotator\src\compat.ts" -Force
Copy-Item patches\types.ts "$npmRoot\tuxevil-rotator\src\types.ts" -Force
Copy-Item patches\providers\google-antigravity\forward.ts "$npmRoot\tuxevil-rotator\src\providers\google-antigravity\forward.ts" -Force

# 6. 启动
tuxevil-rotator start
```

---

## 🧠 核心架构与黑科技原理

### 1. 🌟 反重力客户端原生换号与虚拟指纹隔离
- **Win32 Credential 直接注入**：直接调用 Windows API `Advapi32.dll` 的 `CredWrite` 写入 `gemini:antigravity`，重启反重力 IDE / CLI 无需配置任何 HTTP 代理即可直接以指定账号身份运行。
- **设备指纹隔离 (Device Profile Isolation)**：基于账号唯一哈希为每个账号生成专属虚拟 `machineId`、`macMachineId`、`devDeviceId` 与 `sqmId`，并在同步时自动写入 IDE `globalStorage/storage.json`，防止多账号共用设备指纹导致被风控降权封禁。

### 2. ⚡ 双模型分流与后台任务静默降级
- 每次 API 请求进入时，`applyAutoModelAffinity()` 自动扫描所有账号余量：
  - **Gemini 请求** → 选 Gemini percentRemaining 最高的账号；
  - **Claude 请求** → 选 Claude percentRemaining 最高的账号。
- **标题生成降级**：智能拦截客户端如 Cherry Studio / NextChat / Cursor 发起的“生成会话标题”等轻量级后台请求，静默切换至免费的 `gemini-3.8-flash-high`，杜绝浪费高价值的 Claude 3.5/3.7 配额。

---

## 📁 仓库结构

```
├── src/
│   ├── client-sync.ts          # Win32 凭据写入与虚拟设备指纹隔离引擎
│   └── static/
│       └── gemini-dashboard.html # 极客仪表盘（三轨客户端支持全量定制 UI）
├── patches/
│   ├── proxy.ts                # 代理转子核心、双模型分流与同步 API
│   ├── compat.ts               # OpenAI 兼容层与后台任务静默降级
│   ├── types.ts                # 模型家族前缀自动重定向映射
│   └── providers/
│       └── google-antigravity/ # 反重力协议与 Claude 额度捕获
├── docs/
│   ├── screenshot1.png         # 总览面板截图
│   └── screenshot2.png         # 账号详情截图
├── install.bat                  # Windows 一键安装与补丁注入脚本
└── README.md
```

---

## License

MIT © [ygwbl](https://github.com/ygwbl)

