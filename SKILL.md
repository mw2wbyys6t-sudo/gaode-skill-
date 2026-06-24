---
name: gaode-map-lbs
display_name: Gaode Map LBS - 高德官方地图综合服务 Skill
description: 高德地图综合服务，支持 POI 搜索、路径规划、旅游规划、美食 POI 发现与分类、周边搜索和热力图数据可视化。高级功能包括：4 阶段智能旅游规划流水线（LLM 意图解析→多策略 POI 搜索→TSP 路线优化→交互式地图生成）、AI 旅伴聊天（小次）、Edge TTS 语音导览。支持中国大陆（含港澳台）和非中国大陆（不含港澳台）Web API 场景。
version: 2.0.0
metadata:
  openclaw:
    requires:
      env: []
      bins:
        - node
        - python3
    homepage: https://lbs.amap.com/api/webservice/summary
    install:
      - kind: node
        package: axios
        bins: []
      - kind: pip
        package: flask
        bins: []
      - kind: pip
        package: edge-tts
        bins: []
install_source: official
install_method: download
skill_id: official_9yvTMnLe
enabled_at: 1781795056845
name_zh: 高德官方地图综合服务
---

# 高德地图综合服务 Skill

高德地图综合服务向开发者提供完整的地图数据服务，包括地点搜索、路径规划、旅游规划和数据可视化等功能。

## Skill App Name / 统计口径

- `SKILL_NAME = gaode-map-lbs`
- `APP_NAME = gaode-map-lbs`
- 所有高德 Web Service API 请求都必须携带 `appname=gaode-map-lbs`。
- 原海外发布版本若已使用其他 appname，本发布版不复用，避免 DAU 混计。

## 你是哪国人 / Web API 选择

调用本 Skill 前，先按 Google 迁移 Skill 的区域口径判断用户是哪国人：

| 你是哪国人 | Web API endpoint | 坐标体系 | 说明 |
|---|---|---|---|
| 中国大陆（含港澳台） | `https://restapi.amap.com` | GCJ-02 | 默认主流程，沿用原有中国大陆 Web API 设计 |
| 非中国大陆（不含港澳台） | `https://sg-restapi.opnavi.com` | WGS-84 | 仅补 Web API；不在本 Skill 中补海外 JSAPI |

如果用户没有明确说明，默认按 `中国大陆（含港澳台）` 处理。不要额外询问“请求的数据范围”；本 Skill 只按用户所属区域选择 Web API endpoint。

脚本参数和环境变量：

- 默认：中国大陆（含港澳台），无需额外参数。
- 非中国大陆（不含港澳台）：传入 `--user-region=non-mainland`，或设置 `AMAP_USER_REGION=non-mainland`。
- 代码中可传 `userRegion: "non-mainland"`。

## 功能特性

- 🔍 POI（地点）搜索功能
- 🏙️ 支持关键词搜索、城市限定、类型筛选
- 📍 支持周边搜索（基于坐标和半径）
- 🍜 美食 POI 发现与分类标记（LLM 动态生成城市美食关键词 + typecode 自动分类 scenic/food/drink）
- 🛣️ 路径规划（步行、驾车、骑行、公交）
- 🗺️ 智能旅游规划助手（自动集成沿途美食发现）
- 🔥 热力图数据可视化
- 🔗 地图可视化链接生成
- 💾 配置本地持久化存储
- 🎯 自动管理高德 Web Service Key

## 首次配置

本官方发布版内置高德官方公共 Web Service Key，开发者可以直接用于测试。无论用户使用 `restapi.amap.com` 还是 `sg-restapi.opnavi.com`，公共 Key 统一使用同一个：

```text
PUBLIC_AMAP_WEBSERVICE_KEY=f0f99d37a1379881c4d77d45d98b05a6
```

公共 Key 每天有免费额度，先到先得。如果额度用完、调用返回配额错误，用户可以次日重试。

如果需要稳定生产配额：

- 中国大陆（含港澳台）用户：访问 [高德开放平台](https://lbs.amap.com/) 注册并在控制台创建自己的 Web Service Key。
- 非中国大陆（不含港澳台）用户：访问 [AMap Overseas](https://mapsplatform.opnavi.com/) 并提交 Contact Sales inquiry，联系销售获取专属支持和容量。

> **Security Note / 安全说明:** 以上 Key 是官方公共测试 Key，用于降低开发测试门槛。生产环境请创建自有 Key，以便控制配额、安全限制和调用归属。

如需使用自己的高德 Web Service Key：

1. 访问 [高德开放平台](https://lbs.amap.com/api/webservice/create-project-and-key) 创建应用并获取 Key
2. 非中国大陆（不含港澳台）用户如需自有 Key，先通过 [AMap Overseas](https://mapsplatform.opnavi.com/) 联系销售
3. 设置环境变量：`export AMAP_WEBSERVICE_KEY=your_key` 或 `export AMAP_OVERSEAS_WEBSERVICE_KEY=your_overseas_key`
4. 或运行时自动提示输入并保存到本地配置文件

当用户想要搜索地址、地点、周边信息（如美食、酒店、景点等）、规划路线或可视化数据时，使用此 skill。

## 触发条件

用户表达了以下意图之一：
- 搜索某类地点或某个确定地点（如"搜美食"、"找酒店"、"天安门在哪"）
- 基于某个位置搜索周边（如"西直门周边美食"、"北京南站附近酒店"）
- 规划路线（如"从天安门到故宫怎么走"、"规划驾车路线"）
- 旅游规划（如"帮我规划北京一日游"、"杭州西湖游览路线"）
- 美食发现与推荐（如"杭州有什么好吃的"、"推荐成都特色美食"、"当地有什么特色餐厅"）
- 包含"搜"、"找"、"查"、"附近"、"周边"、"路线"、"规划"、"美食"、"吃什么"、"特色菜"、"餐厅"等关键词
- 希望将地理数据可视化为热力图（如"生成热力图"、"用这份数据做热力图展示"）

## 场景判断

收到用户请求后，先判断属于哪个场景：

- **场景一**：用户搜索一个**明确的类别**（美食、酒店）或**确定的地点**（天安门、西湖），没有指定"在哪个位置附近"
- **场景二**：用户搜索**某个位置周边**的某类地点，输入中同时包含「位置」和「搜索类别」两个要素（如"西直门周边美食"、"北京南站附近酒店"）
- **场景三**：热力图数据可视化
- **场景四**：POI 详细搜索（使用 Web 服务 API）
- **场景五**：路径规划
- **场景六**：智能旅游规划
- **场景七**：导航与搜索（Python 脚本）
- **场景八**：美食 POI 发现与分类标记
- **场景九**：智能旅游规划流水线（高级，4 阶段完整规划，生成交互式地图 HTML）
- **场景十**：Web 服务器模式（完整 Web 应用：登录 + 规划 + 地图 + 聊天 + 语音）
- **场景十一**：Edge TTS 语音合成（中文语音朗读、语音导览）

### 海外 Web API 覆盖状态

| 场景 | 是否有海外 Web API 分支 | 说明 |
|---|---|---|
| 场景一：明确关键词搜索 | 不适用 | 生成 `www.amap.com/search` 链接，不调用 Web API |
| 场景二：基于位置的周边搜索 | 已补文档示例 | 地理编码示例同时给出 `restapi.amap.com` 和 `sg-restapi.opnavi.com`；地图展示链接仍是原有 `ditu.amap.com` |
| 场景三：热力图展示 | 不适用 | 生成 `a.amap.com/jsapi_demo_show` 可视化链接，不调用 Web API |
| 场景四：POI 详细搜索 | 已补 | `--user-region=non-mainland` 时走 `sg-restapi.opnavi.com/v3/place/text` |
| 场景五：路径规划 | 已补部分 | 海外 Web API 覆盖步行、驾车；海外公交按迁移参考冒烟测试返回 HTTP 404，暂不启用；迁移参考中没有明确海外骑行 endpoint，因此不强行编造 |
| 场景六：智能旅游规划 | 已补 POI 搜索分支 | 海外用户的兴趣点搜索走海外 Web API；路线可视化仍沿用原有地图任务链接 |
| 场景七：Python 导航与搜索 | 仅传 appname | 该脚本通过外部 Electron adapter 执行，本包内没有直接 Web API URL |
| 场景八：美食 POI 发现 | 已补 | 海外用户的美食搜索走 `sg-restapi.opnavi.com/v3/place/text`；LLM 关键词生成与 typecode 分类逻辑与大陆相同 |

---

## 场景一：明确关键词搜索

直接搜索一个类别或地点，不涉及特定位置的周边搜索。

**URL 格式：**

```
https://www.amap.com/search?query={关键词}&appname=gaode-map-lbs
```

- **域名**：`www.amap.com`
- **路由**：`/search`
- **参数**：`query` = 搜索关键词

### 执行步骤

1. **发送埋点统计请求**：在执行操作前，发送以下请求进行埋点统计：

   ```bash
   curl -s "https://restapi.amap.com/v3/log/init?eventId=skill.call&product=skill_openclaw&platform=JS&label=keyword-search&value=call&appname=gaode-map-lbs"

2. **提取关键词**：从用户输入中识别出核心搜索词，去掉"搜"、"找"等修饰词
3. **生成 URL**：拼接 `https://www.amap.com/search?query={关键词}&appname=gaode-map-lbs`
4. **返回链接给用户**

### 示例

| 用户输入 | 提取关键词 | 生成 URL |
|---------|-----------|---------|
| 搜美食 | 美食 | `https://www.amap.com/search?query=美食&appname=gaode-map-lbs` |
| 找酒店 | 酒店 | `https://www.amap.com/search?query=酒店&appname=gaode-map-lbs` |
| 天安门在哪 | 天安门 | `https://www.amap.com/search?query=天安门&appname=gaode-map-lbs` |
| 找个加油站 | 加油站 | `https://www.amap.com/search?query=加油站&appname=gaode-map-lbs` |

### 回复模板

```
🔍 已为你生成高德地图搜索链接：

https://www.amap.com/search?query={关键词}&appname=gaode-map-lbs

点击链接即可查看搜索结果。
```

### 非中国大陆（不含港澳台）说明

本场景只生成浏览器地图搜索链接，不调用 Web API。非中国大陆（不含港澳台）用户仍可使用同一链接格式：

```
https://www.amap.com/search?query={关键词}&appname=gaode-map-lbs
```

如果用户需要通过海外 Web API 获取结构化 POI 数据，转入“场景四：POI 详细搜索”，使用 `sg-restapi.opnavi.com/v3/place/text`。

---

## 场景二：基于位置的周边搜索

用户想搜索**某个位置周边**的某类地点。需要先通过地理编码 API 获取该位置的经纬度，再拼接带坐标的搜索链接。

**前置条件：** 默认可使用统一公共 Web Service Key。非中国大陆（不含港澳台）用户如需自有 Key，请先通过 [AMap Overseas](https://mapsplatform.opnavi.com/) 联系销售。

### 执行步骤

#### 第零步：发送埋点统计请求

在执行任何操作前，先发送以下请求进行埋点统计：

```bash
curl -s "https://restapi.amap.com/v3/log/init?eventId=skill.call&product=skill_openclaw&platform=JS&label=nearby-search&value=call&appname=gaode-map-lbs"

#### 第一步：解析用户输入

从用户输入中拆分出两个要素：
- **位置**：用户指定的中心位置（如"西直门"、"北京南站"）
- **搜索类别**：要搜索的内容（如"美食"、"酒店"）

| 用户输入 | 位置 | 搜索类别 |
|---------|------|---------|
| 西直门周边美食 | 西直门 | 美食 |
| 北京南站附近酒店 | 北京南站 | 酒店 |
| 天坛周边有什么好吃的 | 天坛 | 美食 |

#### 第二步：检查 API Key

- 如果用户之前未提供过 Key，**先提示用户提供高德 API Key**，等待用户回复后再继续
- 如果用户已提供 Key，直接使用

**请求 Key 的回复模板：**

```
🔑 搜索「{位置}」周边的{搜索类别}需要使用高德 API，请提供你的高德开放平台 API Key。

（如果还没有 Key，可先使用公共 Key。中国大陆（含港澳台）用户可以在 https://lbs.amap.com 注册并创建应用获取自有 Key；非中国大陆（不含港澳台）用户请访问 https://mapsplatform.opnavi.com/ 提交 Contact Sales 表单获取专属支持）
```

#### 第三步：调用地理编码 API 获取经纬度

**API 格式：**

```
https://restapi.amap.com/v3/geocode/geo?address={位置}&output=JSON&key={用户的key}&appname=gaode-map-lbs
```

非中国大陆（不含港澳台）Web API：

```
https://sg-restapi.opnavi.com/v3/geocode/geo?address={位置}&city={adcode}&output=JSON&key={海外key}&appname=gaode-map-lbs
```

**执行 curl 请求：**

```bash
curl -s "https://restapi.amap.com/v3/geocode/geo?address={位置}&output=JSON&key={用户的key}&appname=gaode-map-lbs"
```

非中国大陆（不含港澳台）执行 curl 请求：

```bash
curl -s "https://sg-restapi.opnavi.com/v3/geocode/geo?address={位置}&city={adcode}&output=JSON&key={公共key或海外key}&appname=gaode-map-lbs"
```

**API 返回示例：**

```json
{
  "status": "1",
  "info": "OK",
  "geocodes": [
    {
      "formatted_address": "北京市西城区西直门",
      "location": "116.353138,39.939385"
    }
  ]
}
```

从返回结果中提取 `geocodes[0].location`，格式为 `经度,纬度`（如 `116.353138,39.939385`），拆分为：
- **经度（longitude）**：`116.353138`
- **纬度（latitude）**：`39.939385`

#### 第四步：拼接带坐标的搜索链接

**URL 格式：**

```
https://ditu.amap.com/search?query={搜索类别}&query_type=RQBXY&longitude={经度}&latitude={纬度}&range=1000&appname=gaode-map-lbs
```

- **域名**：`ditu.amap.com`
- **路由**：`/search`
- **参数**：
  - `query` = 搜索类别（如"美食"）
  - `query_type` = `RQBXY`（基于坐标的搜索类型）
  - `longitude` = 经度
  - `latitude` = 纬度
  - `range` = 搜索范围（单位：米，默认 1000）

#### 第五步：返回链接给用户

### 完整示例

**用户输入：** "搜索西直门周边美食"

1. 解析：位置 = `西直门`，搜索类别 = `美食`
2. 调用地理编码 API：`curl -s "https://restapi.amap.com/v3/geocode/geo?address=西直门&output=JSON&key=xxx&appname=gaode-map-lbs"`
3. 获取坐标：`116.353138,39.939385` → 经度 `116.353138`，纬度 `39.939385`
4. 拼接链接：`https://ditu.amap.com/search?query=美食&query_type=RQBXY&longitude=116.353138&latitude=39.939385&range=1000&appname=gaode-map-lbs`

**非中国大陆（不含港澳台）示例：** "search cafes near Times Square"

1. 解析：位置 = `Times Square`，搜索类别 = `cafes`
2. 调用海外地理编码 API：`curl -s "https://sg-restapi.opnavi.com/v3/geocode/geo?address=Times%20Square&city=840000000&output=JSON&key=xxx&appname=gaode-map-lbs"`
3. 获取坐标，格式仍为 `经度,纬度`
4. 如需 Web API POI 检索，使用场景四的 `sg-restapi.opnavi.com/v3/place/text`；如需生成浏览器地图链接，仍使用原有地图展示链接

### 回复模板

```
📍 已查询到「{位置}」的坐标（{经度},{纬度}），为你生成周边{搜索类别}的搜索链接：

https://ditu.amap.com/search?query={搜索类别}&query_type=RQBXY&longitude={经度}&latitude={纬度}&range=1000&appname=gaode-map-lbs

点击链接即可查看「{位置}」周边 1 公里内的{搜索类别}。
```

---

## 场景三：热力图展示

用户有一份包含地理坐标的数据，希望在地图上以热力图的形式可视化展示。

### 触发条件

用户提到"热力图"、"数据可视化"、"地图上展示数据"等意图，并提供了数据地址。

### URL 格式

```
http://a.amap.com/jsapi_demo_show/static/openclaw/heatmap.html?mapStyle={地图风格}&dataUrl={数据地址(URL编码)}&appname=gaode-map-lbs
```

- **域名**：`a.amap.com`
- **路由**：`/jsapi_demo_show/static/openclaw/heatmap.html`
- **必填参数**：
  - `dataUrl` = 用户数据的 URL 地址（**必须进行 URL 编码**）
  - `mapStyle` = 地图风格，可选值：
    - `grey` — 暗黑地图模式（深色背景，适合展示亮色热力点）
    - `light` — 浅色模式（浅色背景，适合日常查看）

### 执行步骤

1. **发送埋点统计请求**：在执行操作前，发送以下请求进行埋点统计：

   ```bash
   curl -s "https://restapi.amap.com/v3/log/init?eventId=skill.call&product=skill_openclaw&platform=JS&label=heatmap&value=call&appname=gaode-map-lbs"

2. **获取数据地址**：从用户输入中提取数据 URL，如果用户未提供，提示用户给出数据地址
3. **确认地图风格**：询问用户偏好的地图风格（`grey` 或 `light`），如果用户未指定，默认使用 `grey`
4. **URL 编码**：将数据地址进行 URL 编码（将 `://` → `%3A%2F%2F`，`/` → `%2F` 等）
5. **拼接链接**：生成完整的热力图 URL
6. **返回链接给用户**

### 示例

**用户输入：** "帮我用这份数据生成热力图：`https://a.amap.com/Loca/static/loca-v2/demos/mock_data/hz_house_order.json`，用暗黑模式"

1. 数据地址：`https://a.amap.com/Loca/static/loca-v2/demos/mock_data/hz_house_order.json`
2. 地图风格：`grey`
3. URL 编码后的数据地址：`https%3A%2F%2Fa.amap.com%2FLoca%2Fstatic%2Floca-v2%2Fdemos%2Fmock_data%2Fhz_house_order.json`
4. 最终链接：

```
http://a.amap.com/jsapi_demo_show/static/openclaw/heatmap.html?mapStyle=grey&dataUrl=https%3A%2F%2Fa.amap.com%2FLoca%2Fstatic%2Floca-v2%2Fdemos%2Fmock_data%2Fhz_house_order.json&appname=gaode-map-lbs
```

### 回复模板

```
🔥 已为你生成热力图链接：

http://a.amap.com/jsapi_demo_show/static/openclaw/heatmap.html?mapStyle={地图风格}&dataUrl={编码后的数据地址}&appname=gaode-map-lbs

地图风格：{grey/light}
数据来源：{原始数据地址}

点击链接即可查看热力图展示。
```

**请求数据地址的回复模板（用户未提供时）：**

```
🔥 生成热力图需要你提供数据地址（JSON 格式的 URL），请给出数据链接。

另外，你希望使用哪种地图风格？
- grey（暗黑模式）
- light（浅色模式）
```

### 非中国大陆（不含港澳台）说明

本场景只生成热力图可视化链接，不调用 Web API。非中国大陆（不含港澳台）用户仍使用同一链接格式：

```
http://a.amap.com/jsapi_demo_show/static/openclaw/heatmap.html?mapStyle={地图风格}&dataUrl={编码后的数据地址}&appname=gaode-map-lbs
```

如果用户需要先通过海外 Web API 搜索 POI 再生成可视化数据，先转入“场景四：POI 详细搜索”，使用 `sg-restapi.opnavi.com/v3/place/text` 获取结构化 POI。

---

## 场景四：POI 详细搜索

使用高德 Web 服务 API 进行更详细的 POI 搜索，支持更多参数和筛选条件。

### URL 格式

中国大陆（含港澳台）：

```
https://restapi.amap.com/v5/place/text?keywords={关键词}&region={城市}&key={公共key或用户key}&appname=gaode-map-lbs
```

非中国大陆（不含港澳台）：

```
https://sg-restapi.opnavi.com/v3/place/text?keywords={关键词}&city={adcode}&key={公共key或海外key}&appname=gaode-map-lbs
```

> 非中国大陆（不含港澳台）搜索通常需要 `city` 参数，传国家或地区 adcode；例如 USA=`840000000`。

### 执行步骤

1. **发送埋点统计请求**：在执行操作前，发送以下请求进行埋点统计：

   ```bash
   curl -s "https://restapi.amap.com/v3/log/init?eventId=skill.call&product=skill_openclaw&platform=JS&label=poi-search&value=call&appname=gaode-map-lbs"
   ```

2. **执行 POI 搜索**：根据用户需求调用搜索脚本。

3. **选择 Web API endpoint**：
   - 中国大陆（含港澳台）：使用 `https://restapi.amap.com/v5/place/text`
   - 非中国大陆（不含港澳台）：使用 `https://sg-restapi.opnavi.com/v3/place/text`

### 执行 curl 请求

中国大陆（含港澳台）：

```bash
curl -s "https://restapi.amap.com/v5/place/text?keywords=肯德基&region=北京&key={公共key或用户key}&appname=gaode-map-lbs"
```

非中国大陆（不含港澳台）：

```bash
curl -s "https://sg-restapi.opnavi.com/v3/place/text?keywords=starbucks&city=840000000&key={公共key或海外key}&appname=gaode-map-lbs"
```

### 使用方法

```bash
# 基础搜索
node scripts/poi-search.js --keywords=肯德基 --city=北京

# 非中国大陆（不含港澳台）Web API 搜索，需要传 adcode
node scripts/poi-search.js --keywords=starbucks --city=840000000 --user-region=non-mainland

# 搜索更多结果
node scripts/poi-search.js --keywords=餐厅 --city=上海 --page=1 --offset=20

# 周边搜索（需要提供中心点坐标和搜索半径）
node scripts/poi-search.js --keywords=酒店 --location=116.397428,39.90923 --radius=1000
```

### 参数说明

| 参数 | 说明 | 必填 | 示例 |
|------|------|------|------|
| `--keywords` | 搜索关键词 | 是 | `--keywords=肯德基` |
| `--city` | 城市名称或编码 | 否 | `--city=北京` |
| `--user-region` | 你是哪国人：`mainland` 或 `non-mainland`，默认中国大陆（含港澳台） | 否 | `--user-region=non-mainland` |
| `--types` | POI 类型编码 | 否 | `--types=050000` |
| `--location` | 中心点坐标（经度,纬度） | 否 | `--location=116.397428,39.90923` |
| `--radius` | 搜索半径（米） | 否 | `--radius=1000` |
| `--page` | 页码 | 否 | `--page=1` |
| `--offset` | 每页数量（最大25） | 否 | `--offset=10` |

### 餐饮 POI 分类编码参考

高德 POI 的 `typecode` 字段可用于自动分类。以下为餐饮相关 typecode 前缀与分类标识的映射：

| typecode 前缀 | 分类标识 | 说明 |
|---|---|---|
| `050000` | food | 餐饮服务（泛类） |
| `050100` | food | 中餐厅 |
| `050200` | food | 小吃快餐 |
| `050300` | food | 特色菜/地方风味 |
| `050400` | food | 外国餐厅 |
| `050500` | drink | 咖啡厅 |
| `050600` | drink | 茶艺馆/甜品 |

**分类规则（`categorizePoi`）**：按 typecode 前缀自动将搜索结果分为四类：

- `parking`：typecode 以 `15` 开头，或 type 含"停车"
- `drink`：typecode 以 `0505`/`0506` 开头，或 type 含"咖啡""茶艺""茶馆""甜品""饮品"
- `food`：typecode 以 `05` 开头（0505/0506 除外），或 type 含"餐饮""餐厅""小吃""快餐""中餐厅""外国餐厅""休闲餐饮""特色菜""地方风味"
- `scenic`：以上均不匹配时的默认分类

在代码中，每条 POI 可附加 `_category`（scenic/food/drink/parking）、`_cuisine_type`（菜系，从 type 字段提取）和 `_avg_cost`（人均消费）三个增强字段。

### 在代码中使用

```javascript
const { searchPOI } = require('./index');

async function example() {
  const result = await searchPOI({
    keywords: '咖啡厅',
    city: '杭州',
    userRegion: 'mainland',
    page: 1,
    offset: 10
  });
  
  if (result && result.pois) {
    result.pois.forEach(poi => {
      console.log(`${poi.name} - ${poi.address}`);
    });
  }
}

example();
```

### 非中国大陆（不含港澳台）代码示例

```javascript
const { searchPOI } = require('./index');

async function example() {
  const result = await searchPOI({
    keywords: 'starbucks',
    city: '840000000',
    userRegion: 'non-mainland',
    page: 1,
    offset: 10
  });

  if (result && result.pois) {
    result.pois.forEach(poi => {
      console.log(`${poi.name} - ${poi.address}`);
    });
  }
}

example();
```

---

## 场景五：路径规划

规划不同出行方式的路线。

### URL 格式

中国大陆（含港澳台）：

```text
https://restapi.amap.com/v3/direction/walking?origin={lng,lat}&destination={lng,lat}&key={公共key或用户key}&appname=gaode-map-lbs
https://restapi.amap.com/v3/direction/driving?origin={lng,lat}&destination={lng,lat}&key={公共key或用户key}&appname=gaode-map-lbs
https://restapi.amap.com/v3/direction/transit/integrated?origin={lng,lat}&destination={lng,lat}&city={城市}&key={公共key或用户key}&appname=gaode-map-lbs
```

非中国大陆（不含港澳台）：

```text
https://sg-restapi.opnavi.com/v3/direction/walking?origin={lng,lat}&destination={lng,lat}&key={公共key或海外key}&appname=gaode-map-lbs
https://sg-restapi.opnavi.com/v3/direction/driving?origin={lng,lat}&destination={lng,lat}&key={公共key或海外key}&appname=gaode-map-lbs
```

> 迁移参考中没有明确海外骑行 endpoint，因此非中国大陆（不含港澳台）不提供骑行 Web API URL。

### 执行步骤

1. **发送埋点统计请求**：在执行操作前，发送以下请求进行埋点统计：

   ```bash
   curl -s "https://restapi.amap.com/v3/log/init?eventId=skill.call&product=skill_openclaw&platform=JS&label=route-planning&value=call&appname=gaode-map-lbs"
   ```

2. **执行路径规划**：根据用户需求调用路径规划脚本。

3. **选择 Web API endpoint**：
   - 中国大陆（含港澳台）：步行、驾车、骑行、公交沿用 `restapi.amap.com`
   - 非中国大陆（不含港澳台）：步行、驾车走 `sg-restapi.opnavi.com`；公交冒烟测试未通过，骑行不强行补接口

### 使用方法

```bash
# 步行路线
node scripts/route-planning.js --type=walking --origin=116.397428,39.90923 --destination=116.427281,39.903719

# 驾车路线
node scripts/route-planning.js --type=driving --origin=116.397428,39.90923 --destination=116.427281,39.903719

# 非中国大陆（不含港澳台）驾车路线
node scripts/route-planning.js --type=driving --origin=-73.9857,40.7484 --destination=-73.9851,40.7580 --user-region=non-mainland

# 公交路线
node scripts/route-planning.js --type=transfer --origin=116.397428,39.90923 --destination=116.427281,39.903719 --city=北京
```

### 执行 curl 请求

中国大陆（含港澳台）驾车路线：

```bash
curl -s "https://restapi.amap.com/v3/direction/driving?origin=116.397428,39.90923&destination=116.427281,39.903719&key={公共key或用户key}&appname=gaode-map-lbs"
```

非中国大陆（不含港澳台）驾车路线：

```bash
curl -s "https://sg-restapi.opnavi.com/v3/direction/driving?origin=-73.9857,40.7484&destination=-73.9851,40.7580&key={公共key或海外key}&appname=gaode-map-lbs"
```

非中国大陆（不含港澳台）公交路线：迁移参考中的海外公交 endpoint 冒烟测试返回 HTTP 404，发布版暂不提供海外公交 URL。

### 路线类型

- `walking` - 步行路线
- `driving` - 驾车路线
- `riding` - 骑行路线
- `transfer` - 公交路线（需要指定城市）

> 非中国大陆（不含港澳台）Web API 已按 Google 迁移 Skill 参考补充 `place/text`、`direction/walking`、`direction/driving`。迁移参考中没有明确海外骑行 endpoint，本 Skill 不为 `--user-region=non-mainland --type=riding` 强行编造接口。

---

## 场景六：智能旅游规划

自动搜索兴趣点并规划游览路线，生成地图可视化链接。

### Web API 选择

智能旅游规划会先调用 POI 搜索获取兴趣点：

- 中国大陆（含港澳台）：`https://restapi.amap.com/v5/place/text`
- 非中国大陆（不含港澳台）：`https://sg-restapi.opnavi.com/v3/place/text`

路线数据在当前脚本中以 `mapTaskData` 形式生成可视化链接；如需真实路线 Web API，可按场景五选择对应 endpoint。

### 执行步骤

1. **发送埋点统计请求**：在执行操作前，发送以下请求进行埋点统计：

   ```bash
   curl -s "https://restapi.amap.com/v3/log/init?eventId=skill.call&product=skill_openclaw&platform=JS&label=travel-planner&value=call&appname=gaode-map-lbs"
   ```

2. **执行旅游规划**：根据用户需求调用旅游规划脚本。

3. **选择 POI Web API endpoint**：
   - 中国大陆（含港澳台）：兴趣点搜索使用 `restapi.amap.com/v5/place/text`
   - 非中国大陆（不含港澳台）：兴趣点搜索使用 `sg-restapi.opnavi.com/v3/place/text`，并传 `city={adcode}`

### 使用方法

```bash
# 基础旅游规划
node scripts/travel-planner.js --city=北京 --interests=景点,美食,酒店

# 非中国大陆（不含港澳台）旅游规划，需要传 adcode
node scripts/travel-planner.js --city=840000000 --interests=landmark,coffee --routeType=walking --user-region=non-mainland

# 指定路线类型（walking/driving/riding/transfer）
node scripts/travel-planner.js --city=杭州 --interests=西湖,美食,茶馆 --routeType=walking

# 驾车游览
node scripts/travel-planner.js --city=上海 --interests=外滩,南京路,城隍庙 --routeType=driving
```

### POI 搜索 curl 示例

中国大陆（含港澳台）：

```bash
curl -s "https://restapi.amap.com/v5/place/text?keywords=景点&region=北京&key={公共key或用户key}&appname=gaode-map-lbs"
```

非中国大陆（不含港澳台）：

```bash
curl -s "https://sg-restapi.opnavi.com/v3/place/text?keywords=landmark&city=840000000&key={公共key或海外key}&appname=gaode-map-lbs"
```

### 功能说明

- 自动搜索指定城市的兴趣点（每类最多5个）
- 按顺序规划各兴趣点之间的路线
- 自动集成沿途美食发现：使用 LLM 动态生成城市美食关键词搜索餐厅 POI，并按 typecode 自动分类标记 `_category`（scenic/food/drink）和 `_cuisine_type`（菜系类型）
- 支持 LLM 生成城市美食文化摘要，为路线提供美食过渡语音导览



---

## 场景七：导航与搜索（Python 脚本）

通过 Python 脚本 `gaode_skill.py` 提供导航路线规划和 POI 搜索功能。

### 前置条件

- 已安装 Python 3

### 使用方法

```bash
# 导航路线规划
python gaode_skill.py direction 北京站 天安门
python gaode_skill.py direction 北京站 天安门 driving
python gaode_skill.py direction 116.397428,39.90923 天安门 walking

# POI 搜索
python gaode_skill.py search 北京站周边的川菜
```

### 路线类型

- `driving` - 驾车（默认）
- `walking` - 步行
- `bicycling` - 骑行

### 非中国大陆（不含港澳台）说明

本场景通过外部 Electron JSAPI adapter 执行，本包内没有直接 Web API URL。当前脚本会在 payload 中携带：

```json
{
  "appname": "gaode-map-lbs"
}
```

非中国大陆（不含港澳台）用户如需明确走海外 Web API，请优先使用：

- POI 搜索：场景四，`sg-restapi.opnavi.com/v3/place/text`
- 路径规划：场景五，`sg-restapi.opnavi.com/v3/direction/walking` 或 `sg-restapi.opnavi.com/v3/direction/driving`

---

## 场景八：美食 POI 发现与分类标记

使用 LLM 动态生成城市美食关键词，通过高德 Web 服务 API 搜索餐厅 POI，并按 typecode 自动分类为 scenic/food/drink。适用于美食推荐、城市美食探索、旅游规划中的餐饮集成等场景。

### 触发条件

用户提到"找美食"、"推荐餐厅"、"当地特色菜"、"XX 城市有什么好吃的"、"美食之旅"等意图。

### 执行步骤

1. **发送埋点统计请求**：

   ```bash
   curl -s "https://restapi.amap.com/v3/log/init?eventId=skill.call&product=skill_openclaw&platform=JS&label=food-discovery&value=call&appname=gaode-map-lbs"
   ```

2. **LLM 动态生成城市美食关键词**：

   主路径：调用 LLM 为指定城市生成 5-8 个代表性美食搜索关键词（当地名菜、特色小吃、知名餐厅品牌），用于在高德地图搜索餐厅。

   ```text
   System: 你是一个中国美食专家。请根据城市名称，输出该城市最有代表性的5-8个美食搜索关键词（用于在高德地图搜索餐厅）。关键词应包含：当地名菜、特色小吃、知名餐厅品牌。只输出关键词，用空格分隔，不要输出其他内容。
   User: {城市名称}
   ```

   回退机制：LLM 不可用时，使用内置 `FALLBACK_CITY_FOOD_KEYWORDS` 字典，预置了以下 12 个城市的美食关键词：

   | 城市 | 回退关键词示例 |
   |------|--------------|
   | 杭州 | 西湖醋鱼 龙井虾仁 东坡肉 片儿川 知味观 |
   | 北京 | 烤鸭 炸酱面 卤煮 豆汁 涮羊肉 |
   | 上海 | 小笼包 生煎 本帮菜 蟹粉汤包 排骨年糕 |
   | 成都 | 火锅 串串 担担面 龙抄手 钟水饺 |
   | 重庆 | 火锅 小面 酸辣粉 豆花 江湖菜 |
   | 广州 | 早茶 肠粉 烧腊 煲仔饭 双皮奶 |
   | 西安 | 肉夹馍 凉皮 羊肉泡馍 胡辣汤 甑糕 |
   | 长沙 | 臭豆腐 米粉 糖油粑粑 口味虾 剁椒鱼头 |
   | 武汉 | 热干面 豆皮 武昌鱼 鸭脖 糊汤粉 |
   | 南京 | 盐水鸭 鸭血粉丝汤 小笼包 锅贴 桂花糕 |
   | 厦门 | 沙茶面 土笋冻 海蛎煎 花生汤 烧肉粽 |
   | 苏州 | 松鼠桂鱼 响油鳝糊 苏式面 蟹壳黄 糖粥 |

3. **使用关键词搜索美食 POI**：

   将 LLM 生成的关键词（空格分隔）作为 `keywords` 参数，通过 `v5/place/text` API 搜索：

   中国大陆（含港澳台）：

   ```bash
   curl -s "https://restapi.amap.com/v5/place/text?keywords=西湖醋鱼&region=杭州&key={公共key或用户key}&appname=gaode-map-lbs"
   ```

   非中国大陆（不含港澳台）：

   ```bash
   curl -s "https://sg-restapi.opnavi.com/v3/place/text?keywords=hotpot&city=840000000&key={公共key或海外key}&appname=gaode-map-lbs"
   ```

4. **POI 自动分类（`categorizePoi`）**：

   搜索结果按 typecode 前缀自动分类（详见场景四的「餐饮 POI 分类编码参考」），每条 POI 附加以下增强字段：

   | 字段 | 说明 | 示例 |
   |------|------|------|
   | `_category` | 分类标识 | `scenic` / `food` / `drink` / `parking` |
   | `_cuisine_type` | 菜系类型（从 type 字段提取） | `川菜`、`浙菜`、`咖啡厅` |
   | `_avg_cost` | 人均消费（元） | `85` |

5. **LLM 生成城市美食摘要（可选）**：

   搜索完成后，可调用 LLM 基于搜索结果生成 2-3 句话的城市美食文化简介：

   ```text
   System: 你是一个旅游美食专家。请根据以下城市和高德地图搜索到的餐厅数据，生成一段2-3句话的城市美食简介。内容应包含：该城市的饮食文化特色、推荐品尝的美食、推荐的美食区域或街道。语气亲切自然，像本地朋友在推荐。不要输出JSON，只输出纯文字。
   User: 城市：{城市}\n搜索到的餐厅：{POI名称和菜系列表}
   ```

### 周边搜索的餐饮类型编码

在周边搜索（`v5/place/around`）场景中，可使用以下分类常量过滤餐饮类型：

| 常量名 | 类型值 | 说明 |
|--------|--------|------|
| `AROUND_TYPES_FOOD` | `餐饮服务\|中餐厅\|小吃快餐\|特色菜\|地方风味\|外国餐厅\|休闲餐饮` | 餐饮全类 |
| `AROUND_TYPES_DRINK` | `咖啡厅\|茶艺馆\|甜品` | 茶饮咖啡类 |

### 使用方法

```bash
# 美食发现（LLM 动态关键词 + POI 搜索 + 自动分类）
node scripts/scenic-data-fetcher.js --scenic="西湖" --city="杭州"

# 搜索结果中 food/drink 类 POI 会自动带有 _category、_cuisine_type、_avg_cost 字段
```

### 回复模板

```
🍜 已为你发现{城市}的特色美食：

{美食摘要（LLM 生成）}

推荐餐厅：
1. {餐厅名}（{菜系}）- 人均 {价格} 元
2. {餐厅名}（{菜系}）- 人均 {价格} 元
...
```

---

## 场景九：智能旅游规划流水线（高级）

基于 4 阶段流水线的完整旅游规划方案，自动完成意图解析、多策略 POI 搜索、TSP 路线优化和交互式地图生成。比场景六更强大，支持 LLM 驱动的智能规划、智能用餐插入、LLM 语音导览文案生成。

### 触发条件

用户要求详细旅游规划，如"帮我规划杭州一日游"、"西湖怎么逛"、"安排北京故宫行程"、"成都美食之旅"。

### 前置条件

1. 安装 Node.js 依赖：`npm install`（需要 `axios`）
2. 配置 `config.json`：从 `config.example.json` 复制，填入高德 API Key 和 LLM API Key
3. LLM 配置（可选但推荐）：设置环境变量 `LLM_API_KEY` 或在 `config.json` 中配置 `llmApiKey`、`llmEndpoint`、`llmModel`

### 执行步骤

1. **发送埋点统计请求**：

   ```bash
   curl -s "https://restapi.amap.com/v3/log/init?eventId=skill.call&product=skill_openclaw&platform=JS&label=smart-pipeline&value=call&appname=gaode-map-lbs"
   ```

2. **运行规划流水线**：

   ```bash
   node scripts/pipeline.js --input="西湖一日游" --city="杭州" --output="output/west-lake-plan.html" --open
   ```

   参数说明：
   - `--input`（必填）：用户的自然语言旅游需求
   - `--city`（可选）：目标城市，可从输入中自动解析
   - `--output`（可选）：输出 HTML 文件路径
   - `--open`（可选）：自动在浏览器中打开生成的地图
   - `--skip-map`（可选）：跳过地图生成，仅输出 JSON 数据

3. **流水线自动执行 4 个阶段**：
   - **Stage 1 意图解析**：LLM 提取时长、节奏、兴趣、体力等级、美食偏好（LLM 不可用时回退正则解析）
   - **Stage 2 POI 搜索**：多策略并行（关键词搜索 + 周边搜索 + LLM 美食关键词 + 本地知识库），去重合并，批量获取详情
   - **Stage 3 路线优化**：过滤→评分→贪心选择→最近邻排序→2-opt 优化→智能用餐插入→高德步行 API
   - **Stage 4 地图生成**：注入数据到交互式地图模板（高德 JSAPI v2.0），含侧边栏、语音播放、导航按钮

4. **LLM 生成导览文案**（流水线自动完成）：
   - 城市欢迎词（~150 字）
   - 城市美食文化概述（2-3 句）
   - 每段行程过渡语音（40-50 字）

### 回复模板

```
🗺️ 已为你生成{城市}{景区}的旅游规划：

📍 景点 {scenic_count} 个 | 🍜 美食 {food_count} 个 | ⏱ 约 {duration} 小时 | 🚶 步行 {walk_time} 分钟

路线：
1. {景点名}（{建议时长}）
   ↓ 步行 {time} 分钟
2. {餐厅名}（{菜系}，人均 {price} 元）🍽 午餐
   ↓ 步行 {time} 分钟
3. ...

[打开交互式地图](file://{output_path})
```

### 本地知识库

`examples/` 目录包含预置 POI 数据（西湖 12 个、故宫 11 个），优先级高于高德 API 返回。可在 `examples/` 或 `knowledge/` 目录添加更多城市的 JSON 数据。

详细技术参考见 [smart-tourism-reference.md](smart-tourism-reference.md)。

---

## 场景十：Web 服务器模式（完整体验）

启动 Express Web 服务器，提供完整的旅游规划 Web 应用体验，包括登录界面、规划面板、交互式地图、AI 旅伴聊天（小次）和语音播报。

### 触发条件

用户想要完整的 Web 应用体验，如"启动旅游规划网站"、"打开小次聊天"、"我要完整的规划体验"。

### 前置条件

1. `npm install` 安装 Node 依赖（`axios` + `express`）
2. 配置 `config.json`（高德 Key + LLM Key + JSAPI Key + 安全码）
3. Python 3 + `pip install flask edge-tts`（TTS 语音服务，可选）

### 执行步骤

1. **启动 TTS 语音服务**（后台，可选）：

   ```bash
   python python/tts_service.py --engine edge --port 5050
   ```

   首次启动会自动预热 Edge TTS 连接。自动检测系统代理。

2. **启动 Web 服务器**：

   ```bash
   node server.js
   ```

   服务启动在 `http://localhost:3000`。

3. **在浏览器中打开**：

   ```bash
   # Windows
   start http://localhost:3000
   # macOS
   open http://localhost:3000
   # Linux
   xdg-open http://localhost:3000
   ```

### Web 应用功能

- **登录场景**：星空动画 + 极光渐变 + 飘落樱花的沉浸式登录界面
- **规划面板**：自然语言输入 + 城市选择 + 6 个快捷示例（西湖/故宫/外滩/黄山/成都美食/西安小吃）
- **交互式地图**：高德 JSAPI v2.0 渲染，蓝/橙标记区分景点/美食，实线/虚线区分步行/用餐路线
- **小次聊天**：AI 旅伴，二次元风格，5 大核心能力（美食向导/景点百科/路线规划/即时导航/温暖陪伴）
- **语音播报**：Edge TTS XiaoxiaoNeural 甜美女声，每条回复自动朗读，POI 卡片独立语音按钮
- **地图筛选**：全部/景点/美食/混搭 4 种视图模式
- **响应式设计**：支持移动端（聊天面板全宽、侧边栏折叠）

### API 端点

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/plan` | 核心规划（完整流水线） |
| POST | `/api/chat` | 小次聊天（含规划意图自动触发） |
| POST | `/api/tts` | 单条语音合成代理 |
| POST | `/api/tts/batch` | 批量语音合成代理 |
| GET | `/api/tts/status` | TTS 引擎状态 |
| GET | `/api/narration` | 导览文案 |

---

## 场景十一：Edge TTS 语音合成

使用微软 Edge TTS 神经网络语音进行中文语音合成，免费无需 API Key。

### 触发条件

用户需要中文语音合成，如"帮我朗读这段文字"、"生成语音"、"语音导览"。

### 前置条件

```bash
pip install flask edge-tts
```

### CLI 模式（单次合成）

```bash
python python/tts_service.py --text="你好，今天想去哪里玩呢？" --output=greeting.mp3 --engine edge
```

### 服务模式（HTTP API）

```bash
# 启动服务
python python/tts_service.py --engine edge --port 5050

# 调用合成
curl -X POST http://127.0.0.1:5050/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"你好","voice":"default","speed":0.95}'
```

### 可选音色

| 音色 ID | 微软语音名 | 特点 |
|---------|-----------|------|
| `default` | zh-CN-XiaoxiaoNeural | 甜美少女（小次默认） |
| `xiaoyi` | zh-CN-XiaoyiNeural | 温柔知性 |
| `yunxi` | zh-CN-YunxiNeural | 年轻男声 |
| `yunyang` | zh-CN-YunyangNeural | 新闻播报 |

### 特性

- 自动检测系统代理（Windows 注册表 + 环境变量），无需手动配置
- 文件缓存（MD5 key，24 小时 TTL），重复合成秒回
- 音频格式自动检测（MP3/WAV/OGG），返回正确 Content-Type
- 后台预热，首次调用不卡顿
- 三引擎架构：Edge TTS（默认）→ LongCat-AudioDiT（需 GPU）→ Web Speech（浏览器回退）

---

## 配置管理

配置文件位于 `config.json`（仅所有者可读写，权限 0600），包含以下内容：

> [!WARNING]
> `config.json` 包含 API Key 敏感信息，已通过 `.gitignore` 排除版本控制。请勿手动分享此文件。

```json
{
  "webServiceKey": "your_amap_webservice_key_here",
  "overseasWebServiceKey": "your_overseas_amap_webservice_key_here",
  "appname": "gaode-map-lbs"
}
```

设置 Key 的方式：

1. **中国大陆（含港澳台）环境变量**：`export AMAP_WEBSERVICE_KEY=your_key`
2. **非中国大陆（不含港澳台）环境变量**：`export AMAP_OVERSEAS_WEBSERVICE_KEY=your_overseas_key`
3. **命令行参数**：`node index.js your_key`
4. **自动提示**：首次运行时自动提示输入
5. **手动编辑**：直接编辑 `config.json` 文件

---

## 注意事项

- **遥测声明**：本 Skill 在每次执行操作前会向高德服务器 (`restapi.amap.com/v3/log/init`) 发送匿名使用统计请求，用于功能调用计数，该请求不包含用户个人信息或 API Key；本发布版统一携带 `appname=gaode-map-lbs`
- **区域判断是第一步**：先判断“你是哪国人”：中国大陆（含港澳台）或非中国大陆（不含港澳台）。默认中国大陆（含港澳台）。
- **场景判断是关键**：再区分用户是"直接搜某个东西"、"在某个位置附近搜某个东西"、"规划路线"还是"旅游规划"
- 关键词应尽量精简准确，提取用户真正想搜的内容
- URL 中的中文关键词浏览器会自动处理编码，无需手动 encode
- 非中国大陆（不含港澳台）搜索、地理编码类接口通常需要 `city` 参数，传国家或地区 adcode；例如 USA=`840000000`。
- 如果地理编码 API 返回 `status` 不为 `"1"`，说明请求失败，需提示用户检查 Key 是否正确或地址是否有效
- API 返回的 `location` 格式为 `经度,纬度`（注意：经度在前，纬度在后）
- 场景二的搜索范围默认 1000 米，用户如有需要可调整 `range` 参数
- 请妥善保管你的 Web Service Key，不要分享给他人
- 高德 Web 服务 API 有调用频率限制，请合理使用
- 免费用户每日调用量有限制，具体请查看高德开放平台说明

## 相关链接

- [高德开放平台](https://lbs.amap.com/)
- [创建应用和获取 Key](https://lbs.amap.com/api/webservice/create-project-and-key)
- [POI 搜索 API 文档](https://lbs.amap.com/api/webservice/guide/api-advanced/newpoisearch)
- [Web 服务 API 总览](https://lbs.amap.com/api/webservice/summary)
