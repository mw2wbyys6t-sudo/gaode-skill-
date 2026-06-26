# 次元旅人 + 餐饮选址通 — 智能旅游规划 & 餐饮选址分析

> 基于高德地图 API + LLM 的综合地理智能 Skill。旅游规划自动生成带语音导览的交互式地图；餐饮选址提供多半径竞争扫描、商圈画像、100 分制评分和 Word 报告。

![Version](https://img.shields.io/badge/version-3.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%3E%3D16-339933?logo=node.js)
![Python](https://img.shields.io/badge/python-3.8+-3776AB?logo=python)

## 功能亮点

- **4 阶段旅游规划流水线** — 意图解析 → 多策略 POI 搜索 → TSP 路线优化 → 交互式地图生成
- **5 阶段餐饮选址流水线** — 意图解析 → 多半径竞争扫描 → 商圈画像 → 100 分 5 维评分 → HTML + Word 双报告
- **LLM 驱动** — 自动理解旅行偏好（节奏、兴趣、体力、美食口味）或选址需求（餐饮类型、预算、目标客群）
- **美食发现** — LLM 动态生成城市美食关键词，搜索并分类餐厅（景点/美食/茶饮自动标注）
- **交互式地图** — 高德 JSAPI v2.0 渲染，蓝/橙标记区分景点与美食，步行/用餐路线分色显示
- **AI 旅伴「小次」** — 二次元风格聊天机器人，支持美食推荐、景点百科、路线规划、即时导航
- **语音导览** — Edge TTS 神经网络语音，自动生成城市欢迎词、美食文化概述和行程过渡文案
- **Word 选址报告** — docx 库生成专业排版文档，含封面、五维评分雷达图、竞争密度表、商圈画像、LLM 综合建议

### 餐饮选址通（v3.0 新增）

一句话输入（如"在成都春熙路开火锅店"），自动完成 5 阶段全流程分析：

- **选址意图解析** — LLM 自动识别餐饮类型、目标城市、候选商圈、月租预算、店铺类型
- **多半径竞争扫描** — 150m/500m/1km/3km 四层同心圆 POI 扫描，逐页去重、顺序请求避免 QPS 限流
- **商圈画像** — 商业 POI 密度、住宅 POI 密度、交通便利度、互补业态评分，自动判定商圈类型
- **100 分 5 维评分** — 战略因素 / 竞争因素 / 销售潜力 / 服务配套 / 立地条件，各 20 分
- **多商圈对比** — 同时分析多个候选区域，横向对比推荐首选
- **LLM 综合建议** — 结合评分数据生成口语化建议，含风险提示和实地考察指导
- **双格式报告** — HTML 交互式报告（雷达图 + 地图 + 对比卡片）+ Word 专业文档（封面 + 表格 + 嵌入雷达图 PNG）
- **反直觉竞争评分** — 竞品越多得分越高（代表成熟商圈），避免新手误判"无竞争 = 好位置"

### 小次主动旅伴（v2.1）

小次从被动聊天工具升级为全程旅伴，在关键场景主动提供帮助：

- **浮动气泡** — 地图页右下角呼吸动画头像，气泡对话框 5 秒自动淡出
- **智能引导** — 输入模糊时（如"杭州"），小次主动追问 1-2 个细化问题；输入够具体则直接规划
- **地图加载** — 规划完成后自动播放城市欢迎语音 + 弹出行程摘要气泡
- **POI 上下文提示** — 点击地图标记，小次即时分享景点小知识或美食推荐
- **用餐提醒** — 基于行程时间线，在用餐 POI 前 30 分钟弹出提醒
- **空闲建议** — 30 秒无操作，小次主动推荐下一步操作
- **心情系统** — 根据场景自动切换 emoji

### 旅行手账（v2.1）

路线规划完成后，一键生成可分享的手绘风旅行手账：

- **手绘风模板** — CDN 手写字体（ZCOOL KuaiLe / Ma Shan Zheng / Caveat），纸张纹理，和纸胶带装饰
- **拍立得相框** — 景点卡片带轻微旋转和阴影，优先使用真实照片
- **时间轴布局** — 虚线连接所有站点，步行时间和用餐时间分色标注
- **城市主题贴纸** — 自动识别城市并显示主题 emoji（杭州→🪷、成都→🐼、西安→🗿 等）
- **季节色调** — 春夏秋冬四套配色方案自动切换
- **成就徽章** — 根据行程数据动态生成（打卡数、菜系数、步行距离等）
- **PNG 导出** — html2canvas 客户端渲染，无需服务器依赖，2x 高清输出

## 技术架构

### 旅游规划流水线

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

### 餐饮选址流水线

```
"在成都春熙路开火锅店"
    │
    ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Stage 1     │    │  Stage 2     │    │  Stage 3     │    │  Stage 4     │    │  Stage 5     │
│  意图解析    │───▶│  竞争扫描    │───▶│  商圈画像    │───▶│  选址评分    │───▶│  报告生成    │
│  (LLM)       │    │  (4层同心圆) │    │  (POI密度)   │    │  (100分5维)  │    │  (HTML+Word) │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

### 模块总览

| 模块 | 文件 | 职责 |
|------|------|------|
| 旅游流水线 | `scripts/pipeline.js` | 串联 4 个阶段，管理数据流 |
| 意图解析 | `scripts/intent-parser.js` | LLM 提取旅行偏好（时长/节奏/兴趣/美食） |
| POI 搜索 | `scripts/scenic-data-fetcher.js` | 关键词 + 周边 + LLM 美食关键词 + 分页去重 + QPS 保护 |
| 路线优化 | `scripts/route-optimizer.js` | 贪心选择 → 最近邻 → 2-opt → 智能用餐插入 |
| 地图生成 | `scripts/map-visualizer.js` | 注入数据到交互式 HTML 模板 |
| 聊天管理 | `scripts/dialogue-manager.js` | 小次人格 + 意图路由 + 会话上下文 + 选址对话 |
| 选址流水线 | `scripts/site-pipeline.js` | 串联 5 个选址阶段，管理数据流 |
| 选址意图 | `scripts/site-intent-parser.js` | LLM 识别餐饮类型/城市/商圈/预算 |
| 竞争扫描 | `scripts/competition-scanner.js` | 4 层同心圆 POI 扫描，顺序请求 + 分页去重 |
| 商圈画像 | `scripts/area-profiler.js` | 商业/住宅/交通/互补业态密度分析 |
| 选址评分 | `scripts/site-analyzer.js` | 100 分 5 维评分 + 多商圈对比 |
| Word 报告 | `scripts/site-report-docx.js` | docx + sharp 生成专业排版文档 |
| 语音合成 | `python/tts_service.py` | Edge TTS / LongCat / Web Speech 三引擎 |
| Web 服务器 | `server.js` | Express API + 选址/旅游双流水线 + TTS 代理 |

## 快速开始

### 环境要求

- Node.js >= 16
- Python 3.8+（语音功能可选）
- 高德 API Key（[免费申请](https://lbs.amap.com/)）
- LLM API Key（推荐 DeepSeek，可选）

> **注意**：在创建高德 API Key 时一定要选择"Web服务"类型。

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
  "amapWebServiceKey": "高德 Web Service API Key（选址和旅游都需要）",
  "amapJsapiKey": "高德 JS API Key（前端地图使用）",
  "amapSecurityJsCode": "高德 JS API 安全码",
  "amapOverseasWebServiceKey": "高德海外 Web Service Key（可选）",
  "llmApiKey": "LLM API Key（如 DeepSeek）",
  "llmEndpoint": "https://api.deepseek.com/v1/chat/completions",
  "llmModel": "deepseek-chat",
  "appname": "gaode-map-lbs"
}
```

## 使用方式

### 餐饮选址分析（v3.0）

```bash
# 最简用法：一句话选址分析
node scripts/site-pipeline.js --input="在成都春熙路开火锅店"

# 指定输出路径并自动打开
node scripts/site-pipeline.js --input="在长沙五一广场开湘菜馆" --output=my-report.html --open

# 或使用 npm scripts
npm run site -- --input="在广州天河开奶茶店，月租1万以内"
npm run site-report  # 带 --open 自动打开浏览器
```

**选址参数说明：**

| 参数 | 必填 | 说明 |
|------|------|------|
| `--input` | 是 | 自然语言选址需求 |
| `--city` | 否 | 城市名称覆盖（可从输入自动解析） |
| `--output` | 否 | 输出 HTML 路径（默认 `output/site-report.html`） |
| `--open` | 否 | 完成后自动在浏览器中打开 |

选址分析完成后会同时输出 HTML 交互式报告和 Word 专业文档（`output/site-report.docx`），Word 报告包含封面页、五维评分雷达图、竞争密度表、商圈画像、多商圈对比表和 LLM 综合建议。

### 旅游规划

```bash
# 规划杭州西湖一日游
node scripts/pipeline.js --input="西湖一日游" --city="杭州" --open

# 成都美食之旅
node scripts/pipeline.js --input="成都美食之旅" --city="成都" --open

# 仅输出 JSON 数据，不生成地图
node scripts/pipeline.js --input="故宫半日游" --city="北京" --skip-map
```

**旅游参数说明：**

| 参数 | 必填 | 说明 |
|------|------|------|
| `--input` | 是 | 自然语言旅游需求 |
| `--city` | 否 | 目标城市（可从输入自动解析） |
| `--output` | 否 | 输出 HTML 路径（默认 `tour-map.html`） |
| `--open` | 否 | 自动在浏览器中打开 |
| `--skip-map` | 否 | 跳过地图生成，仅输出 JSON |

### Web 服务器（完整体验）

```bash
# 1. 启动 TTS 语音服务（后台）
python python/tts_service.py --engine edge --port 5050

# 2. 启动 Web 服务器
node server.js

# 3. 打开浏览器
# Windows: start http://localhost:3000
# macOS:   open http://localhost:3000
```

Web 应用提供：星空登录动画、规划输入面板、交互式地图、侧边栏行程卡片、选址分析入口、小次聊天面板（含语音播报）。

### 单独模块调用

```bash
# 仅做旅游意图解析
node scripts/intent-parser.js --input="我想周末去杭州逛逛西湖吃吃当地美食"

# 仅做选址意图解析
node scripts/site-intent-parser.js --input="在大学城附近开一家麻辣烫"

# 仅搜索 POI
node scripts/scenic-data-fetcher.js --scenic="西湖" --city="杭州"

# 仅搜索美食
node scripts/poi-search.js --keywords=咖啡厅 --city=杭州

# 路线规划
node scripts/route-planning.js --type=walking --origin=120.13,30.26 --destination=120.15,30.25
```

## 项目结构

```
gaode-skill-/
├── SKILL.md                          # Skill 定义文件（12 个场景）
├── README.md                         # 项目说明文档
├── smart-tourism-reference.md        # 高级功能技术参考
├── index.html                        # 前端 SPA（登录 + 地图 + 聊天 + 选址）
├── server.js                         # Express Web 服务器
├── index.js                          # 模块入口（POI/路线/地理编码）
├── gaode_skill.py                    # Python 导航脚本
├── package.json                      # Node 依赖
├── requirements.txt                  # Python 依赖
├── config.example.json               # 配置模板
├── scripts/
│   ├── pipeline.js                   # 旅游 4 阶段流水线编排
│   ├── intent-parser.js              # 旅游 LLM 意图解析
│   ├── scenic-data-fetcher.js        # 多策略 POI 搜索 + 分页去重
│   ├── route-optimizer.js            # TSP + 2-opt 路线优化
│   ├── map-visualizer.js             # 交互式地图 HTML 生成
│   ├── dialogue-manager.js           # 小次聊天管理 + 选址对话
│   ├── session-store.js              # 会话状态管理
│   ├── poi-search.js                 # POI 搜索脚本
│   ├── route-planning.js             # 路线规划脚本
│   ├── travel-planner.js             # 旅游规划脚本
│   ├── food-data-provider.js         # 美食数据供给
│   ├── journal-generator.js          # 旅行手账生成
│   ├── site-pipeline.js              # 选址 5 阶段流水线编排
│   ├── site-intent-parser.js         # 选址 LLM 意图解析
│   ├── competition-scanner.js        # 多半径竞争扫描
│   ├── area-profiler.js              # 商圈画像分析
│   ├── site-analyzer.js              # 100 分 5 维评分 + 多商圈对比
│   └── site-report-docx.js           # Word 选址报告生成
├── python/
│   ├── tts_service.py                # Edge TTS 语音合成服务
│   ├── pipeline.py                   # Python 旅游规划流水线
│   ├── intent_parser.py              # Python 意图解析
│   ├── scenic_data_fetcher.py        # Python POI 搜索
│   ├── route_optimizer.py            # Python 路线优化
│   ├── map_visualizer.py             # Python 地图生成
│   └── __init__.py
├── templates/
│   ├── interactive-map.html          # 交互式旅游地图模板
│   ├── site-report.html              # 选址分析报告模板（HTML）
│   └── travel-journal.html           # 旅行手账模板
├── examples/
│   ├── west-lake.json                # 西湖预置 POI（12 个）
│   └── forbidden-city.json           # 故宫预置 POI（11 个）
└── assets/
    └── xiaoci-avatar.png             # 小次头像
```

## 选址评分模型

100 分制，分为 5 个维度各 20 分：

| 维度 | 分值 | 评估内容 |
|------|------|----------|
| 战略因素 | 20 | 城市等级 + 商圈类型 + 发展趋势 |
| 竞争因素 | 20 | 核心圈竞争密度 + 同品类占比（反直觉：竞品越多得分越高） |
| 销售潜力 | 20 | 人流代理指标 + 捕获率估算 |
| 服务配套 | 20 | 互补业态评分 + 交通可达性 |
| 立地条件 | 20 | 区域类型 + 街道可达性 + 物业可行性 |

评级标准：80+ 优秀、60-79 良好、40-59 及格、40 以下不推荐。

## 语音导览

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

## API 端点（Web 服务器模式）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/plan` | 完整旅游规划流水线 |
| POST | `/api/chat` | 小次聊天（可自动触发规划或选址） |
| GET | `/api/site-analysis` | 餐饮选址分析（端到端） |
| POST | `/api/tts` | 单条语音合成 |
| POST | `/api/tts/batch` | 批量语音合成 |
| GET | `/api/tts/status` | TTS 引擎状态 |
| GET | `/api/narration` | 导览文案 |

## npm scripts 速查

```bash
npm start           # 启动 Web 服务器
npm run plan        # 旅游规划流水线
npm run site        # 选址分析流水线
npm run site-report # 选址分析 + 自动打开浏览器
npm run intent      # 仅旅游意图解析
npm run scenic      # POI 搜索
npm run route       # 路线优化
npm run visualize   # 地图生成
npm run journal     # 旅行手账生成
npm run tts         # 启动 TTS 语音服务
```

## QoderWork Skill 安装

本项目可作为 QoderWork Skill 安装使用。下载 `.skill` 文件后，在 QoderWork 中点击安装即可。安装后可通过自然语言直接与 AI 对话进行旅游规划或餐饮选址分析。

Skill 支持的对话场景包括：POI 搜索、路径规划、周边搜索、热力图数据、旅游规划、美食发现、AI 旅伴聊天、语音导览、旅行手账、餐饮选址分析等 12 个场景。


## 许可证

MIT License

## 致谢

- [高德开放平台](https://lbs.amap.com/) — 地图数据与 API 服务
- [Edge TTS](https://github.com/rany2/edge-tts) — 微软神经网络语音合成
- [DeepSeek](https://www.deepseek.com/) — LLM 意图解析与文案生成
- [docx](https://docx.js.org/) — Word 文档生成库
- [sharp](https://sharp.pixelplumbing.com/) — 高性能图像处理（SVG → PNG 雷达图渲染）
