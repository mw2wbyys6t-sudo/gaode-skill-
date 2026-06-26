# 次元旅人高级功能技术参考

本文档是 gaode-map-lbs skill 场景九、十、十一的详细技术参考。

## config.json 完整字段

```json
{
  "amapWebServiceKey": "高德 Web Service API Key（POI 搜索、路径规划、地理编码）",
  "amapJsapiKey": "高德 JS API Key（前端地图渲染，仅 Web 服务器模式需要）",
  "amapSecurityJsCode": "高德 JS API 安全码（配合 JSAPI Key 使用）",
  "amapOverseasWebServiceKey": "海外高德 API Key（sg-restapi.opnavi.com）",
  "llmEndpoint": "https://api.deepseek.com/v1/chat/completions",
  "llmApiKey": "LLM API 密钥（DeepSeek/OpenAI 兼容格式）",
  "llmModel": "deepseek-chat",
  "appname": "gaode-map-lbs"
}
```

Key 解析优先级：环境变量 > config.json > 内置公共 Key `f0f99d37a1379881c4d77d45d98b05a6`。
LLM Key 环境变量：`LLM_API_KEY`、`LLM_ENDPOINT`、`LLM_MODEL`。

## 4 阶段流水线详解

### Stage 1: 意图解析 (`scripts/intent-parser.js`)

**LLM 模式**：发送用户输入到 OpenAI 兼容 API，系统提示包含 3 条 few-shot 示例，输出 9 字段 JSON。
**正则回退**：LLM 不可用时自动切换，覆盖 26 个景区名、20 种菜系、8 类兴趣。

输出 Schema：
```json
{
  "duration_hours": 4,        // 游玩时长（小时）
  "pace": "moderate",         // leisurely / moderate / fast
  "interests": ["ancient_architecture", "food"],  // 8 类可选
  "physical_level": "medium", // low / medium / high
  "must_see": [],             // 必看景点
  "avoid": [],                // 回避
  "scenic_area": "西湖",      // 景区名
  "city": "杭州",             // 城市
  "food_preferences": {
    "want_food": true,
    "cuisine_types": ["浙菜"],
    "budget_level": "mid-range",
    "meal_times": ["lunch"],
    "food_focus": false
  }
}
```

### Stage 2: POI 搜索 (`scripts/scenic-data-fetcher.js`)

多策略并行搜索流程：
1. 地理编码景区名 → 获取中心坐标
2. 并行执行：关键词搜索 + 周边景点 + 周边美食 + 周边饮品 + 周边停车场 + LLM 城市美食关键词 + 本地知识库
3. 全部来源去重合并
4. Top 20 POI 批量获取详情（并发 5，批间延迟）
5. 与本地知识库合并（本地优先）

高德 API 端点：v5/place/text、v5/place/around、v5/place/detail、v5/geocode/geo、v5/place/inputtips。

POI 增强字段：`_category`（scenic/food/drink/parking）、`_cuisine_type`（菜系）、`_avg_cost`（人均）。

### Stage 3: 路线优化 (`scripts/route-optimizer.js`)

6 阶段算法：

| 阶段 | 方法 | 说明 |
|------|------|------|
| 1. 过滤 | filterPois | 按兴趣和体力等级筛选 |
| 2. 评分 | scorePois | 兴趣匹配(0.4) + 优先级(0.3) + 时长适配(0.3)，美食偏好 1.5x |
| 3. 选择 | selectPois | 贪心选择，累积游览+步行时间直至预算耗尽 |
| 4. 排序 | orderPoisNN | 最近邻 TSP 启发式 |
| 5. 优化 | twoOptImprove | 2-opt 局部搜索，最多 100 轮，最小改进 1m |
| 6. 路线 | Gaode Walking API | v3/direction/walking，失败回退 Haversine×1.3 |

步行速度（按体力等级）：

| 体力 | 速度 |
|------|------|
| low | 60 m/min |
| medium | 80 m/min |
| high | 100 m/min |

**智能用餐插入**（insertMealStops）：
- 假设 9:00 出发，计算每个 POI 的到达/离开时间
- 用餐时段：早餐 7-9、午餐 11:30-13、晚餐 17:30-19、下午茶 14-16
- 在匹配时段的最佳插入点，搜索最近匹配菜系的餐厅
- 标记 `_is_meal_segment` 用于地图虚线渲染

### Stage 4: 地图生成 (`scripts/map-visualizer.js`)

读取 `templates/interactive-map.html` 模板，替换 3 个占位符：
- `__MAP_DATA__` — 完整路线 JSON 数据
- `__AMAP_KEY__` — JSAPI Key
- `__SECURITY_CODE__` — 安全码

输出自包含 HTML 文件，可直接在浏览器打开。

### LLM 导览文案生成（pipeline.js 内）

3 组并行 LLM 调用：
- `generateCityWelcome` — 城市欢迎词（~150 字）
- `generateCityFoodSummary` — 美食文化概述（2-3 句）
- `generateTransitionNarrations` — 每段过渡语音（40-50 字，食物段更活泼）

## 小次聊天系统 (`scripts/dialogue-manager.js`)

### 人格设定
二次元 AI 旅伴，活泼开朗、热爱美食和旅行、偶尔傲娇。输出专为 TTS 优化：口语化短句、自然停顿、禁止 Markdown、颜文字/emoji 各限 1 个。

### 5 大核心能力
美食向导、景点百科、智能路线规划、即时导航、温暖陪伴。

### 意图路由（4 类）

| 意图 | 关键词示例 | 动作 |
|------|-----------|------|
| plan | 规划、安排、行程、路线、一日游 | 触发完整流水线，渲染地图 |
| navigate | 带我去、怎么走、导航 | 路径指引 + 高德 URI |
| query | 推荐、附近、搜一下 | POI 查询推荐 |
| chat | 其他 | 闲聊 |

### 标记格式
- `[place:名称|经度|纬度|类别]` — 地点卡片
- `[route:起点->终点|方式]` — 路线卡片

前端解析后渲染为可点击卡片，点击定位地图。

### 偏好提取
15 个关键词映射菜系（辣→川菜/湘菜、清淡→粤菜等），预算（经济/中档/高端），9 类兴趣。

## 会话管理 (`scripts/session-store.js`)

### 状态 Schema
```json
{
  "city": "杭州",
  "scenicName": "西湖",
  "preferences": {
    "cuisine_types": ["浙菜"],
    "budget_level": "mid-range",
    "interests": ["nature"],
    "food_focus": false
  },
  "recommendedPlaces": [
    { "name": "断桥", "category": "scenic", "lng": 120.15, "lat": 30.26 }
  ],
  "currentPlan": {}
}
```

- 滑动窗口：最近 20 轮对话（40 条消息）
- 自动过期：2 小时无活动，每 30 分钟清理
- `unref()` 定时器不阻塞进程退出

## 本地知识库格式

`examples/` 目录 JSON 文件结构：
```json
{
  "scenic_name": "西湖",
  "city": "杭州",
  "pois": [
    {
      "name": "断桥残雪",
      "location": { "lng": 120.153, "lat": 30.261 },
      "type": "风景名胜",
      "typecode": "110201",
      "suggested_duration": 30,
      "priority": 95,
      "description": "西湖十景之一...",
      "tags": ["5A", "免费", "标志性"]
    }
  ]
}
```

优先级高于高德 API 返回。可在 `examples/` 或 `knowledge/` 添加更多城市数据。

## CLI 参数速查表

| 模块 | 参数 | 说明 |
|------|------|------|
| **pipeline.js** | `--input` | 自然语言输入（必填） |
| | `--city` | 城市（可选，自动解析） |
| | `--output` | 输出 HTML 路径 |
| | `--open` | 自动打开浏览器 |
| | `--skip-map` | 跳过地图生成 |
| **intent-parser.js** | `--input` | 用户输入文本 |
| **scenic-data-fetcher.js** | `--scenic` | 景区名 |
| | `--city` | 城市 |
| **route-optimizer.js** | — | 仅编程接口调用 |
| **map-visualizer.js** | `--data` | JSON 数据文件 |
| | `--output` | 输出 HTML 路径 |
| | `--open` | 自动打开浏览器 |
| **tts_service.py** | `--engine` | edge（默认）/ audiodit / webspeech |
| | `--port` | HTTP 端口（默认 5050） |
| | `--text` | CLI 模式合成文本 |
| | `--output` | CLI 模式输出文件 |
| | `--voice` | 音色 ID |
| | `--device` | GPU: cuda / cpu |

## TTS 服务详细配置 (`python/tts_service.py`)

### 引擎架构

| 引擎 | 说明 | 依赖 |
|------|------|------|
| EdgeTTSEngine | 默认，微软神经网络语音，免费 | `edge-tts`, `flask` |
| LongCatAudioDiTEngine | 本地 GPU 推理（需模型） | CUDA + 模型文件 |
| WebSpeechFallback | 返回 JSON 让浏览器 Web Speech | 无 |

### HTTP 端点

| 方法 | 路径 | 请求体 | 响应 |
|------|------|--------|------|
| POST | `/tts` | `{text, voice, speed}` | audio/mpeg 或 JSON |
| GET | `/tts/health` | — | `{status, engine, model_loaded}` |
| POST | `/tts/batch` | `{items[], voice, speed}` | `{results[]}` |

### 特性
- **代理检测**：环境变量 HTTPS_PROXY → Windows 注册表 ProxyServer → 自动传给 edge_tts
- **预热**：启动时后台合成短文本，预建立 HTTPS 连接
- **缓存**：`.tts-cache/` 目录，MD5 key，24 小时 TTL
- **格式检测**：魔字节识别 MP3/WAV/OGG，返回正确 Content-Type
- **音色**：default(XiaoxiaoNeural)、xiaoyi(XiaoyiNeural)、yunxi(YunxiNeural)、yunyang(YunyangNeural)
