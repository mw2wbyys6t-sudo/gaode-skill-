# 🌌 次元旅人 — 智能旅游规划系统

> 基于高德地图 API + LLM 的智能旅游规划 Skill，自动生成带语音导览的交互式地图。

![Version](https://img.shields.io/badge/version-2.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%3E%3D16-339933?logo=node.js)
![Python](https://img.shields.io/badge/python-3.8+-3776AB?logo=python)

## ✨ 功能亮点

- **4 阶段智能规划流水线** — 意图解析 → 多策略 POI 搜索 → TSP 路线优化 → 交互式地图生成
- **LLM 驱动** — 自动理解你的旅行偏好（节奏、兴趣、体力、美食口味），零人工维护城市知识库
- **美食发现** — LLM 动态生成城市美食关键词，搜索并分类餐厅（景点/美食/茶饮自动标注）
- **交互式地图** — 高德 JSAPI v2.0 渲染，蓝/橙标记区分景点与美食，步行/用餐路线分色显示
- **AI 旅伴「小次」** — 二次元风格聊天机器人，支持美食推荐、景点百科、路线规划、即时导航
- **语音导览** — Edge TTS 神经网络语音，自动生成城市欢迎词、美食文化概述和行程过渡文案
- **完整 Web 体验** — Express 服务器 + 星空登录动画 + 规划面板 + 侧边栏 + 聊天面板

### 🗣️ 小次主动旅伴（v2.1）

小次从被动聊天工具升级为**全程旅伴**，在关键场景主动提供帮助：

- **浮动气泡** — 地图页右下角呼吸动画头像，气泡对话框 5 秒自动淡出
- **智能引导** — 输入模糊时（如"杭州"），小次主动追问 1-2 个细化问题；输入够具体则直接规划
- **地图加载** — 规划完成后自动播放城市欢迎语音 + 弹出行程摘要气泡
- **POI 上下文提示** — 点击地图标记，小次即时分享景点小知识或美食推荐
- **用餐提醒** — 基于行程时间线，在用餐 POI 前 30 分钟弹出提醒
- **空闲建议** — 30 秒无操作，小次主动推荐下一步操作
- **心情系统** — 根据场景自动切换 emoji（😊 happy / 🤩 excited / 🤔 curious / 🍜 hungry / 💤 sleepy）

### 📖 旅行手账（v2.1）

路线规划完成后，一键生成可分享的手绘风旅行手账：

- **手绘风模板** — CDN 手写字体（ZCOOL KuaiLe / Ma Shan Zheng / Caveat），纸张纹理，和纸胶带装饰
- **拍立得相框** — 景点卡片带轻微旋转和阴影，优先使用真实照片
- **时间轴布局** — 虚线连接所有站点，步行时间和用餐时间分色标注
- **城市主题贴纸** — 自动识别城市并显示主题 emoji（杭州→🪷、成都→🐼、西安→🗿 等）
- **季节色调** — 春夏秋冬四套配色方案自动切换
- **成就徽章** — 根据行程数据动态生成（打卡数、菜系数、步行距离等）
- **PNG 导出** — html2canvas 客户端渲染，无需服务器依赖，2x 高清输出

## 🏗️ 技术架构

```
用户输入（自然语言）
    │
    ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Stage 1     │    │  Stage 2     │    │  Stage 3     │    │  Stage 4     │
│  意图解析    │───▶│  POI 搜索    │───▶│  路线优化    │───▶│  地图生成    │
│  (LLM)       │    │  (多策略)    │    │  (TSP+2-opt) │    │  (JSAPI)     │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

| 模块 | 文件 | 职责 |
|------|------|------|
| 流水线编排 | `scripts/pipeline.js` | 串联 4 个阶段，管理数据流 |
| 意图解析 | `scripts/intent-parser.js` | LLM 提取旅行偏好（时长/节奏/兴趣/美食） |
| POI 搜索 | `scripts/scenic-data-fetcher.js` | 关键词 + 周边 + LLM 美食关键词 + 本地知识库 |
| 路线优化 | `scripts/route-optimizer.js` | 贪心选择 → 最近邻 → 2-opt → 智能用餐插入 |
| 地图生成 | `scripts/map-visualizer.js` | 注入数据到交互式 HTML 模板 |
| 聊天管理 | `scripts/dialogue-manager.js` | 小次人格 + 意图路由 + 会话上下文 |
| 语音合成 | `python/tts_service.py` | Edge TTS / LongCat / Web Speech 三引擎 |
| Web 服务器 | `server.js` | Express API + TTS 代理 + 静态文件服务 |

## 🚀 快速开始

### 环境要求

- Node.js >= 16
- Python 3.8+（语音功能可选）
- 高德 API Key（[免费申请](https://lbs.amap.com/)）
- LLM API Key（推荐 DeepSeek，可选）

### 安装

```bash
# 克隆仓库
git clone https://github.com/mw2wbyys6t-sudo/gaode-skill-.git
cd gaode-skill-

# 安装 Node 依赖
npm install

# 安装 Python 依赖（可选，语音功能需要）
pip install -r requirements.txt

# 创建配置文件
cp config.example.json config.json
# 编辑 config.json，填入你的 API Key
```

### config.json 配置说明

```json
{
  "amapWebServiceKey": "高德 Web Service API Key",
  "amapJsapiKey": "高德 JS API Key（前端地图使用）",
  "amapSecurityJsCode": "高德 JS API 安全码",
  "amapOverseasWebServiceKey": "高德海外 Web Service Key（可选）",
  "llmApiKey": "LLM API Key（如 DeepSeek）",
  "llmEndpoint": "https://api.deepseek.com/v1/chat/completions",
  "llmModel": "deepseek-chat",
  "appname": "gaode-map-lbs"
}
```

## 📖 使用方式

### 方式一：命令行规划（最快）

```bash
# 规划杭州西湖一日游
node scripts/pipeline.js --input="西湖一日游" --city="杭州" --open

# 成都美食之旅
node scripts/pipeline.js --input="成都美食之旅" --city="成都" --open

# 仅输出 JSON 数据，不生成地图
node scripts/pipeline.js --input="故宫半日游" --city="北京" --skip-map
```

**参数说明：**

| 参数 | 必填 | 说明 |
|------|------|------|
| `--input` | ✅ | 自然语言旅游需求 |
| `--city` | ❌ | 目标城市（可从输入自动解析） |
| `--output` | ❌ | 输出 HTML 路径（默认 `tour-map.html`） |
| `--open` | ❌ | 自动在浏览器中打开 |
| `--skip-map` | ❌ | 跳过地图生成，仅输出 JSON |

### 方式二：Web 服务器（完整体验）

```bash
# 1. 启动 TTS 语音服务（后台）
python python/tts_service.py --engine edge --port 5050

# 2. 启动 Web 服务器
node server.js

# 3. 打开浏览器
# Windows: start http://localhost:3000
# macOS:   open http://localhost:3000
```

Web 应用提供：星空登录动画、规划输入面板、交互式地图、侧边栏行程卡片、小次聊天面板（含语音播报）。

### 方式三：单独模块调用

```bash
# 仅做意图解析
node scripts/intent-parser.js --input="我想周末去杭州逛逛西湖吃吃当地美食"

# 仅搜索 POI
node scripts/scenic-data-fetcher.js --scenic="西湖" --city="杭州"

# 仅搜索美食
node scripts/poi-search.js --keywords=咖啡厅 --city=杭州

# 路线规划
node scripts/route-planning.js --type=walking --origin=120.13,30.26 --destination=120.15,30.25
```

## 🗂️ 项目结构

```
gaode-skill-/
├── SKILL.md                          # Skill 定义文件（11 个场景）
├── smart-tourism-reference.md        # 高级功能技术参考
├── index.html                        # 前端 SPA（登录 + 地图 + 聊天）
├── server.js                         # Express Web 服务器
├── index.js                          # 模块入口（POI/路线/地理编码）
├── gaode_skill.py                    # Python 导航脚本
├── package.json                      # Node 依赖
├── requirements.txt                  # Python 依赖
├── config.example.json               # 配置模板
├── scripts/
│   ├── pipeline.js                   # 4 阶段流水线编排
│   ├── intent-parser.js              # LLM 意图解析
│   ├── scenic-data-fetcher.js        # 多策略 POI 搜索
│   ├── route-optimizer.js            # TSP + 2-opt 路线优化
│   ├── map-visualizer.js             # 交互式地图 HTML 生成
│   ├── dialogue-manager.js           # 小次聊天管理
│   ├── session-store.js              # 会话状态管理
│   ├── poi-search.js                 # POI 搜索脚本
│   ├── route-planning.js             # 路线规划脚本
│   └── travel-planner.js             # 旅游规划脚本
├── python/
│   ├── tts_service.py                # Edge TTS 语音合成服务
│   └── __init__.py
├── templates/
│   └── interactive-map.html          # 交互式地图模板
├── examples/
│   ├── west-lake.json                # 西湖预置 POI（12 个）
│   └── forbidden-city.json           # 故宫预置 POI（11 个）
└── assets/
    └── xiaoci-avatar.png             # 小次头像
```

## 🎙️ 语音导览

Edge TTS 提供免费的神经网络语音合成，无需 API Key：

```bash
# CLI 单次合成
python python/tts_service.py --text="你好，欢迎来到杭州" --engine edge

# 服务模式（供 Web 应用调用）
python python/tts_service.py --engine edge --port 5050
```

可选音色：

| 音色 | 特点 |
|------|------|
| `default` (XiaoxiaoNeural) | 甜美少女，小次默认音色 |
| `xiaoyi` (XiaoyiNeural) | 温柔知性 |
| `yunxi` (YunxiNeural) | 年轻男声 |
| `yunyang` (YunyangNeural) | 新闻播报风格 |

## 🔧 API 端点（Web 服务器模式）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/plan` | 完整规划流水线 |
| POST | `/api/chat` | 小次聊天（可自动触发规划） |
| POST | `/api/tts` | 单条语音合成 |
| POST | `/api/tts/batch` | 批量语音合成 |
| GET | `/api/tts/status` | TTS 引擎状态 |
| GET | `/api/narration` | 导览文案 |

## 📄 许可证

MIT License

## 🙏 致谢

- [高德开放平台](https://lbs.amap.com/) — 地图数据与 API 服务
- [Edge TTS](https://github.com/rany2/edge-tts) — 微软神经网络语音合成
- [DeepSeek](https://www.deepseek.com/) — LLM 意图解析与文案生成
