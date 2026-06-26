/**
 * 次元旅人 - 智能旅游规划器
 * 景区 POI 数据抓取模块 (Node.js)
 *
 * 全面接入高德开放平台 Web Service API：
 *   - v5/place/text       关键词搜索（主搜索）
 *   - v5/place/around     周边搜索（发现附近景点、餐饮、停车场）
 *   - v5/place/detail     POI 详情（图片、评分、营业时间、电话等）
 *   - v5/geocode/geo      地理编码（景区名称 → 坐标，用于周边搜索中心点）
 *   - v5/place/inputtips  输入提示（景区名联想）
 *   - v3/direction/walking 步行路径规划（已在 route-optimizer 中使用）
 *
 * 功能：
 *   - 多策略搜索：关键词搜索 + 周边搜索，结果去重合并
 *   - POI 数据增强：建议游览时长、标签、优先级评分、图片、评分、营业时间
 *   - 支持加载本地 JSON 知识库文件，本地数据优先级高于 API 返回
 *   - 支持中国大陆（restapi.amap.com）和海外（sg-restapi.opnavi.com）两套端点
 *   - 发送遥测日志
 *
 * CLI 用法：
 *   node scenic-data-fetcher.js --scenic="西湖" --city="杭州"
 *
 * 模块导出：
 *   fetchScenicPOIs(scenicName, city, options)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 常量 & 默认配置
// ---------------------------------------------------------------------------

/** 内置测试 Key（仅用于开发调试） */
const BUILTIN_TEST_KEY = 'f0f99d37a1379881c4d77d45d98b05a6';

/** 高德 Web Service API 端点 */
const API_ENDPOINTS = {
  mainland: {
    placeText:    'https://restapi.amap.com/v5/place/text',
    placeAround:  'https://restapi.amap.com/v5/place/around',
    placeDetail:  'https://restapi.amap.com/v5/place/detail',
    geocode:      'https://restapi.amap.com/v5/geocode/geo',
    inputtips:    'https://restapi.amap.com/v5/place/inputtips',
  },
  overseas: {
    placeText:    'https://sg-restapi.opnavi.com/v3/place/text',
    placeAround:  'https://sg-restapi.opnavi.com/v3/place/around',
    placeDetail:  'https://sg-restapi.opnavi.com/v3/place/detail',
    geocode:      'https://sg-restapi.opnavi.com/v3/geocode/geo',
    inputtips:    'https://sg-restapi.opnavi.com/v3/place/inputtips',
  },
};

/** 遥测日志端点 */
const TELEMETRY_URL = 'https://restapi.amap.com/v3/log/init';

/** 搜索类型过滤 */
const SEARCH_TYPES = '风景名胜|旅游景点';

/** 周边搜索的附加类型（发现附近的餐饮、停车场等配套设施） */
const AROUND_TYPES_SCENIC = '风景名胜|旅游景点|公园|广场|博物馆|纪念馆|寺庙';
const AROUND_TYPES_FOOD = '餐饮服务|中餐厅|小吃快餐|特色菜|地方风味|外国餐厅|休闲餐饮';
const AROUND_TYPES_DRINK = '咖啡厅|茶艺馆|甜品';
const AROUND_TYPES_PARKING = '停车场';

/** 餐饮选址通 - 互补业态类型常量 */
const AROUND_TYPES_TRANSIT = '地铁站|公交站';
const AROUND_TYPES_COMMERCIAL = '商场|购物中心|写字楼|商务住宅';
const AROUND_TYPES_RESIDENTIAL = '住宅小区|宿舍|公寓';
const AROUND_TYPES_COMPLEMENTARY = '便利店|超市|电影院|茶艺馆|咖啡厅';

/** 应用名称，所有 API 请求都会带上 */
const APP_NAME = 'gaode-map-lbs';

/**
 * POI 类型 → 建议游览时长映射（分钟）
 * 键为高德 POI type 中可能出现的关键词
 */
const TYPE_DURATION_MAP = [
  { keywords: ['风景名胜', '公园', '广场', '景区', '湖泊', '山峰'], min: 45, max: 90 },
  { keywords: ['博物馆', '纪念馆', '展览馆', '艺术馆', '陈列馆'], min: 60, max: 120 },
  { keywords: ['寺庙', '古建筑', '古迹', '遗址', '古镇', '宫殿'], min: 30, max: 60 },
  { keywords: ['园林', '花园', '植物园'], min: 45, max: 75 },
  { keywords: ['餐饮', '美食', '餐厅', '小吃'], min: 30, max: 60 },
  { keywords: ['购物', '商场', '市场', '商店'], min: 30, max: 60 },
  { keywords: ['停车场', '公交', '地铁'], min: 5, max: 10 },
];

/** 默认建议游览时长（分钟） */
const DEFAULT_DURATION = 30;

/** 周边搜索半径（米） */
const AROUND_RADIUS = 2000;

/** POI 详情批量获取的最大数量 */
const MAX_DETAIL_FETCH = 20;

// ---------------------------------------------------------------------------
// 配置读取
// ---------------------------------------------------------------------------

/**
 * 解析高德 Web Service Key
 * 优先级：options.apiKey > 环境变量 AMAP_WEBSERVICE_KEY > config.json > 内置测试 Key
 *
 * @param {object} [options] - 可选配置
 * @param {string} [options.apiKey] - 直接传入的 API Key
 * @returns {string} 解析到的 API Key
 */
function resolveApiKey(options = {}) {
  // 1. 高德专用 Web Service Key（优先，避免被 options.apiKey 中的 LLM 密钥覆盖）
  if (options.amapWebServiceKey) {
    return options.amapWebServiceKey;
  }

  // 2. 直接传入的 API Key（通用字段）
  if (options.apiKey) {
    return options.apiKey;
  }

  // 3. 环境变量
  if (process.env.AMAP_WEBSERVICE_KEY) {
    return process.env.AMAP_WEBSERVICE_KEY;
  }

  // 4. config.json（沿 scripts/ 向上查找）
  const configPaths = [
    path.resolve(__dirname, '..', 'config.json'),
    path.resolve(__dirname, 'config.json'),
  ];

  for (const cfgPath of configPaths) {
    try {
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        if (cfg.amapWebServiceKey) {
          return cfg.amapWebServiceKey;
        }
      }
    } catch (err) {
      console.warn(`[配置] 读取 ${cfgPath} 失败: ${err.message}`);
    }
  }

  // 5. 内置测试 Key
  console.warn('[配置] 未找到 API Key，使用内置测试 Key（仅供调试）');
  return BUILTIN_TEST_KEY;
}

// ---------------------------------------------------------------------------
// 遥测
// ---------------------------------------------------------------------------

/**
 * 发送遥测日志到高德（静默执行，不阻塞主流程）
 */
function sendTelemetry() {
  const url = `${TELEMETRY_URL}?appname=${encodeURIComponent(APP_NAME)}`;
  axios
    .get(url, { timeout: 3000 })
    .catch(() => {
      // 遥测失败不影响主流程
    });
}

// ---------------------------------------------------------------------------
// POI 数据增强
// ---------------------------------------------------------------------------

/**
 * 根据 POI 的 type 字段推断建议游览时长
 *
 * @param {string} poiType - 高德返回的 POI type 字符串
 * @returns {number} 建议游览时长（分钟），取区间中值
 */
function inferSuggestedDuration(poiType) {
  if (!poiType) return DEFAULT_DURATION;

  for (const rule of TYPE_DURATION_MAP) {
    if (rule.keywords.some((kw) => poiType.includes(kw))) {
      // 返回区间中值作为建议时长
      return Math.round((rule.min + rule.max) / 2);
    }
  }

  return DEFAULT_DURATION;
}

/**
 * 根据 POI 类型和名称生成标签
 *
 * @param {object} rawPoi - 高德原始 POI 数据
 * @returns {string[]} 标签数组
 */
function generateTags(rawPoi) {
  const tags = [];

  // 从 type 中提取主标签
  if (rawPoi.type) {
    const parts = rawPoi.type.split(';');
    parts.forEach((p) => {
      const trimmed = p.trim();
      if (trimmed) tags.push(trimmed);
    });
  }

  // 如果有 biz_ext 中的 tag，也加入
  if (rawPoi.biz_ext && rawPoi.biz_ext.tag) {
    const extTags = Array.isArray(rawPoi.biz_ext.tag)
      ? rawPoi.biz_ext.tag
      : [rawPoi.biz_ext.tag];
    extTags.forEach((t) => {
      if (t && !tags.includes(t)) tags.push(t);
    });
  }

  // 特殊标签推断
  if (rawPoi.name) {
    if (rawPoi.name.includes('世界遗产') || rawPoi.name.includes('世遗')) {
      tags.push('世界遗产');
    }
    if (rawPoi.name.includes('5A') || (rawPoi.biz_ext && rawPoi.biz_ext.rating === '5A')) {
      tags.push('5A景区');
    }
    if (rawPoi.name.includes('4A') || (rawPoi.biz_ext && rawPoi.biz_ext.rating === '4A')) {
      tags.push('4A景区');
    }
  }

  return tags.length > 0 ? tags : ['景点'];
}

/**
 * 计算 POI 优先级评分（0-100）
 * 评分依据：类型权重 + 评分加成 + 热度
 *
 * @param {object} rawPoi - 高德原始 POI 数据
 * @returns {number} 优先级评分
 */
function calculatePriority(rawPoi) {
  let score = 50; // 基础分

  // 风景名胜类型加分
  if (rawPoi.type) {
    if (rawPoi.type.includes('风景名胜')) score += 20;
    else if (rawPoi.type.includes('旅游景点')) score += 15;
    else if (rawPoi.type.includes('博物馆')) score += 15;
    else if (rawPoi.type.includes('公园')) score += 10;
    else if (rawPoi.type.includes('园林')) score += 12;
    else if (rawPoi.type.includes('寺庙')) score += 10;
  }

  // 用户评分加成（高德 biz_ext.rating 可能是数字或等级字符串）
  if (rawPoi.biz_ext && rawPoi.biz_ext.rating) {
    const rating = parseFloat(rawPoi.biz_ext.rating);
    if (!isNaN(rating)) {
      score += Math.min(rating * 3, 15); // 最高加 15 分
    }
  }

  // 5A/4A 景区加成
  if (rawPoi.biz_ext && rawPoi.biz_ext.rating) {
    if (rawPoi.biz_ext.rating === '5A') score += 10;
    else if (rawPoi.biz_ext.rating === '4A') score += 5;
  }

  // 有图片的 POI 稍微加分（信息更丰富）
  if (rawPoi.images && rawPoi.images.length > 0) {
    score += 3;
  }

  return Math.min(Math.round(score), 100);
}

/**
 * 根据高德 POI 的 typecode 和 type 字段，将 POI 分类
 *
 * 分类规则：
 *   - typecode 05xxxx  → 'food'（餐饮）
 *   - typecode 0505xx / 0506xx / type 含"咖啡""茶""甜品" → 'drink'（茶饮咖啡）
 *   - typecode 15xxxx / type 含"停车" → 'parking'
 *   - 其他 → 'scenic'（景点）
 *
 * @param {object} rawPoi - 高德原始 POI 数据
 * @returns {string} 分类标识：'scenic' | 'food' | 'drink' | 'parking'
 */
function categorizePoi(rawPoi) {
  const typecode = rawPoi.typecode || '';
  const type = rawPoi.type || '';

  // 停车场
  if (typecode.startsWith('15') || type.includes('停车')) {
    return 'parking';
  }

  // 茶饮咖啡（0505 咖啡厅, 0506 茶艺馆）
  if (typecode.startsWith('0505') || typecode.startsWith('0506') ||
      type.includes('咖啡') || type.includes('茶艺') || type.includes('茶馆') ||
      type.includes('甜品') || type.includes('饮品')) {
    return 'drink';
  }

  // 餐饮（05xxxx 全系列）
  if (typecode.startsWith('05') || type.includes('餐饮') || type.includes('美食') ||
      type.includes('餐厅') || type.includes('小吃') || type.includes('快餐') ||
      type.includes('中餐厅') || type.includes('外国餐厅') || type.includes('休闲餐饮') ||
      type.includes('特色菜') || type.includes('地方风味')) {
    return 'food';
  }

  return 'scenic';
}

/**
 * 从高德 POI 数据中提取菜系类型（仅对 food/drink 类 POI 有意义）
 *
 * @param {object} rawPoi - 高德原始 POI 数据
 * @returns {string} 菜系类型，如 "川菜"、"浙菜"、"咖啡厅"，无则为空字符串
 */
function extractCuisineType(rawPoi) {
  const type = rawPoi.type || '';
  // 高德 type 字段格式如 "餐饮服务;中餐厅;四川菜(川菜)"，取最后一级
  const parts = type.split(';').map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    // 取第二或第三级作为菜系
    const cuisine = parts[parts.length - 1];
    // 清理括号格式如 "四川菜(川菜)" → "川菜"
    const match = cuisine.match(/\((.+)\)/);
    if (match) return match[1];
    // 如果最后一级是泛类（如"中餐厅"），取更具体的
    if (cuisine.includes('餐厅') && parts.length >= 3) {
      return parts[parts.length - 1];
    }
    return cuisine;
  }
  return '';
}

/**
 * 从高德 POI 数据中提取人均消费（元）
 *
 * @param {object} rawPoi - 高德原始 POI 数据
 * @returns {number|null} 人均消费金额，或 null
 */
function extractAvgCost(rawPoi) {
  if (rawPoi.biz_ext && rawPoi.biz_ext.cost) {
    const cost = parseFloat(rawPoi.biz_ext.cost);
    if (!isNaN(cost) && cost > 0) return cost;
  }
  return null;
}

/**
 * 将高德原始 POI 数据转换为增强后的结构化对象
 *
 * @param {object} rawPoi - 高德 API 返回的单条 POI
 * @returns {object} 增强后的 POI 对象
 */
function enrichPoi(rawPoi) {
  // 解析经纬度
  let lng = null;
  let lat = null;
  if (rawPoi.location) {
    if (typeof rawPoi.location === 'string') {
      const parts = rawPoi.location.split(',');
      if (parts.length === 2) {
        lng = parseFloat(parts[0]);
        lat = parseFloat(parts[1]);
      }
    } else if (typeof rawPoi.location === 'object') {
      lng = rawPoi.location.lng || rawPoi.location.lon || null;
      lat = rawPoi.location.lat || null;
    }
  }

  // 提取图片
  const photos = extractPhotos(rawPoi);

  // 提取营业时间
  const businessHours = extractBusinessHours(rawPoi);

  // 提取评分（数字形式）
  const rating = extractRating(rawPoi);

  return {
    name: rawPoi.name || '',
    address: rawPoi.address || '',
    location: { lng, lat },
    type: rawPoi.type || '未知',
    tags: generateTags(rawPoi),
    suggested_duration_minutes: inferSuggestedDuration(rawPoi.type),
    priority: calculatePriority(rawPoi),
    description: (rawPoi.biz_ext && rawPoi.biz_ext.description) || '',
    // 新增：POI 分类与美食属性
    _category: categorizePoi(rawPoi),
    _cuisine_type: extractCuisineType(rawPoi),
    _avg_cost: extractAvgCost(rawPoi),
    // 新增：增强的 POI 信息
    photos: photos,
    business_hours: businessHours,
    rating: rating,
    business_area: rawPoi.business_area || '',
    citycode: rawPoi.citycode || '',
    // 保留原始 ID，方便调试
    _amap_id: rawPoi.id || null,
    _tel: rawPoi.tel || null,
  };
}

/**
 * 从高德 POI 数据中提取图片 URL 列表
 * 支持 v5 的 images 字段和 biz_ext 中的图片数据
 *
 * @param {object} rawPoi - 高德原始 POI
 * @returns {string[]} 图片 URL 数组
 */
function extractPhotos(rawPoi) {
  const photos = [];

  // v5 API: images 字段
  if (rawPoi.images && Array.isArray(rawPoi.images)) {
    rawPoi.images.forEach((img) => {
      const url = typeof img === 'string' ? img : (img.url || img.image_url || '');
      if (url && !photos.includes(url)) photos.push(url);
    });
  }

  // biz_ext 中的图片
  if (rawPoi.biz_ext) {
    if (rawPoi.biz_ext.images && Array.isArray(rawPoi.biz_ext.images)) {
      rawPoi.biz_ext.images.forEach((img) => {
        const url = typeof img === 'string' ? img : (img.url || '');
        if (url && !photos.includes(url)) photos.push(url);
      });
    }
    // 单张图片
    if (rawPoi.biz_ext.photo && !photos.includes(rawPoi.biz_ext.photo)) {
      photos.push(rawPoi.biz_ext.photo);
    }
  }

  // v3 兼容: photos 字段
  if (rawPoi.photos && Array.isArray(rawPoi.photos)) {
    rawPoi.photos.forEach((p) => {
      const url = typeof p === 'string' ? p : (p.url || '');
      if (url && !photos.includes(url)) photos.push(url);
    });
  }

  return photos;
}

/**
 * 从高德 POI 数据中提取营业时间
 *
 * @param {object} rawPoi - 高德原始 POI
 * @returns {string} 营业时间描述
 */
function extractBusinessHours(rawPoi) {
  if (rawPoi.biz_ext) {
    if (rawPoi.biz_ext.opentime) return rawPoi.biz_ext.opentime;
    if (rawPoi.biz_ext.business_hours) return rawPoi.biz_ext.business_hours;
    if (rawPoi.biz_ext.open_time) return rawPoi.biz_ext.open_time;
  }
  // v5 可能有顶层 business
  if (rawPoi.business && rawPoi.business.opentime) return rawPoi.business.opentime;
  return '';
}

/**
 * 从高德 POI 数据中提取评分（数字）
 *
 * @param {object} rawPoi - 高德原始 POI
 * @returns {number|null} 评分（0-5），或 null
 */
function extractRating(rawPoi) {
  if (rawPoi.biz_ext && rawPoi.biz_ext.rating) {
    const r = parseFloat(rawPoi.biz_ext.rating);
    if (!isNaN(r) && r > 0 && r <= 5) return r;
  }
  // v5 的 cost 字段（人均消费）
  if (rawPoi.biz_ext && rawPoi.biz_ext.cost) {
    // 保留但不作为评分
  }
  return null;
}

// ---------------------------------------------------------------------------
// 高德 API 调用
// ---------------------------------------------------------------------------

/**
 * 判断景区是否属于海外（非中国大陆）
 *
 * @param {object} options - 配置选项
 * @returns {string} 'mainland' 或 'overseas'
 */
function resolveRegion(options = {}) {
  if (options.region === 'overseas') return 'overseas';
  return 'mainland';
}

/**
 * 获取指定区域的 API 端点集合
 */
function getEndpoints(options = {}) {
  const region = resolveRegion(options);
  return API_ENDPOINTS[region];
}

/**
 * 地理编码 - 将景区名称/地址转换为坐标
 * 用于确定周边搜索的中心点
 *
 * @param {string} address - 地址或景区名称
 * @param {string} city - 城市名称
 * @param {string} apiKey - API Key
 * @param {object} options - 配置选项
 * @returns {Promise<{lng: number, lat: number}|null>} 坐标或 null
 */
async function geocodeAddress(address, city, apiKey, options = {}) {
  const endpoints = getEndpoints(options);

  // v2 fix: 将城市名前拼到地址中，避免短景区名被高德地理编码误解
  // 例如 "西湖" + city="杭州" → 查询 "杭州西湖" 而非 "西湖"（否则返回南昌西湖区）
  let queryAddress = address;
  if (city && !address.startsWith(city)) {
    queryAddress = city + address;
  }

  const params = {
    key: apiKey,
    address: queryAddress,
    city: city || '',
    output: 'JSON',
    appname: APP_NAME,
  };

  console.log(`[地理编码] 查询: "${queryAddress}" (原始: "${address}", 城市: ${city || '自动'})`);

  try {
    const response = await axios.get(endpoints.geocode, {
      params,
      timeout: options.timeout || 8000,
      headers: { 'User-Agent': `${APP_NAME}/1.0` },
    });

    const data = response.data;
    if (data.status !== '1' && data.status !== 1) {
      console.warn(`[地理编码] 高德返回错误: ${data.info || '未知'}`);
      return null;
    }

    if (data.geocodes && data.geocodes.length > 0) {
      const geo = data.geocodes[0];
      if (geo.location) {
        const parts = geo.location.split(',');
        if (parts.length === 2) {
          const lng = parseFloat(parts[0]);
          const lat = parseFloat(parts[1]);
          console.log(`[地理编码] 成功: ${geo.formatted_address || address} → (${lng}, ${lat})`);
          return { lng, lat, formatted_address: geo.formatted_address || '' };
        }
      }
    }

    console.warn('[地理编码] 未找到匹配结果');
    return null;
  } catch (err) {
    console.warn(`[地理编码] 请求失败: ${err.message}`);
    return null;
  }
}

/**
 * 关键词搜索 - 使用 v5/place/text 搜索景区 POI
 *
 * @param {string} scenicName - 景区名称
 * @param {string} city - 城市名称
 * @param {string} apiKey - API Key
 * @param {object} options - 配置选项
 * @returns {Promise<object[]>} 增强后的 POI 数组
 */
async function fetchFromAmap(scenicName, city, apiKey, options = {}) {
  const endpoints = getEndpoints(options);
  const baseUrl = endpoints.placeText;

  // 构建请求参数
  const params = {
    key: apiKey,
    keywords: scenicName,
    city: city,
    types: SEARCH_TYPES,
    offset: options.pageSize || 25,
    page: 1,
    appname: APP_NAME,
    output: 'JSON',
  };

  // 海外端点参数差异
  if (resolveRegion(options) === 'overseas') {
    delete params.types;
  }

  console.log(`[关键词搜索] 请求: ${baseUrl}`);
  console.log(`[关键词搜索] keywords="${scenicName}", city="${city}"`);

  try {
    const response = await axios.get(baseUrl, {
      params,
      timeout: options.timeout || 10000,
      headers: { 'User-Agent': `${APP_NAME}/1.0` },
    });

    const data = response.data;

    if (data.status !== '1' && data.status !== 1) {
      const errMsg = data.info || data.infocode || '未知错误';
      console.error(`[关键词搜索] 高德返回错误: status=${data.status}, info=${errMsg}`);
      return [];
    }

    const rawPois = data.pois || [];
    console.log(`[关键词搜索] 获取到 ${rawPois.length} 条 POI 数据`);

    return rawPois.map(enrichPoi);
  } catch (err) {
    if (err.response) {
      console.error(`[关键词搜索] HTTP 错误: ${err.response.status} - ${err.response.statusText}`);
    } else if (err.code === 'ECONNABORTED') {
      console.error('[关键词搜索] 请求超时，请检查网络连接');
    } else {
      console.error(`[关键词搜索] 请求失败: ${err.message}`);
    }
    return [];
  }
}

/**
 * 周边搜索 - 使用 v5/place/around 在指定坐标附近搜索 POI
 * 可搜索景点、餐饮、停车场等不同类型
 *
 * @param {number} lng - 中心点经度
 * @param {number} lat - 中心点纬度
 * @param {string} apiKey - API Key
 * @param {object} options - 配置选项
 * @param {string} [options.types] - 搜索类型
 * @param {string} [options.keywords] - 搜索关键词
 * @param {number} [options.radius] - 搜索半径（米）
 * @param {number} [options.pageSize] - 每页返回数量
 * @returns {Promise<object[]>} 增强后的 POI 数组
 */
async function fetchAround(lng, lat, apiKey, options = {}) {
  const endpoints = getEndpoints(options);
  const baseUrl = endpoints.placeAround;

  const types = options.types || AROUND_TYPES_SCENIC;
  const radius = options.radius || AROUND_RADIUS;
  const pageSize = options.pageSize || 20;
  const maxPages = options.maxPages || 1;  // 分页支持：默认1页（向后兼容），选址扫描可设为3-4页

  const allRawPois = [];
  const seenIds = new Set();

  const searchLabel = options.searchLabel || '周边搜索';
  console.log(`[${searchLabel}] 中心: (${lng.toFixed(4)}, ${lat.toFixed(4)}), 半径: ${radius}m, 类型: ${types}${maxPages > 1 ? `, 最多${maxPages}页` : ''}`);

  for (let page = 1; page <= maxPages; page++) {
    const params = {
      key: apiKey,
      location: `${lng},${lat}`,
      types: types,
      keywords: options.keywords || '',
      radius: radius,
      offset: pageSize,
      page: page,
      sortrule: options.sortrule || 'distance',
      appname: APP_NAME,
      output: 'JSON',
    };

    // 移除空参数
    if (!params.keywords) delete params.keywords;

    try {
      const response = await axios.get(baseUrl, {
        params,
        timeout: options.timeout || 10000,
        headers: { 'User-Agent': `${APP_NAME}/1.0` },
      });

      const data = response.data;

      if (data.status !== '1' && data.status !== 1) {
        const errMsg = data.info || '未知';
        console.warn(`[${searchLabel}] 高德返回错误 (page ${page}): ${errMsg}`);
        // QPS限流时停止后续分页，返回已获取的数据
        if (errMsg.includes('CUQPS') || errMsg.includes('QPS') || errMsg.includes('QUOTA')) {
          console.warn(`[${searchLabel}] 检测到QPS限流，停止分页`);
          break;
        }
        continue;
      }

      const rawPois = data.pois || [];
      if (rawPois.length === 0) break;  // 无更多数据，提前终止分页

      // 按 _amap_id 去重
      for (const poi of rawPois) {
        if (poi.id && seenIds.has(poi.id)) continue;
        if (poi.id) seenIds.add(poi.id);
        allRawPois.push(poi);
      }

      console.log(`[${searchLabel}] 第${page}页获取 ${rawPois.length} 条（累计 ${allRawPois.length} 条）`);

      // 如果本页数据不满 pageSize，说明已到最后一页
      if (rawPois.length < pageSize) break;

      // 分页间延迟 200ms，避免 QPS 限流
      if (page < maxPages) {
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (err) {
      console.warn(`[${searchLabel}] 请求失败 (page ${page}): ${err.message}`);
      break;  // 网络错误时停止分页
    }
  }

  console.log(`[${searchLabel}] 共获取 ${allRawPois.length} 条 POI 数据`);
  return allRawPois.map(enrichPoi);
}

/**
 * POI 详情查询 - 使用 v5/place/detail 获取单条 POI 的丰富信息
 * 包含图片、评分、营业时间、人均消费等
 *
 * @param {string} poiId - 高德 POI ID
 * @param {string} apiKey - API Key
 * @param {object} options - 配置选项
 * @returns {Promise<object|null>} 增强后的 POI 详情，或 null
 */
async function fetchPoiDetail(poiId, apiKey, options = {}) {
  const endpoints = getEndpoints(options);
  const baseUrl = endpoints.placeDetail;

  const params = {
    key: apiKey,
    id: poiId,
    appname: APP_NAME,
    output: 'JSON',
  };

  try {
    const response = await axios.get(baseUrl, {
      params,
      timeout: options.timeout || 6000,
      headers: { 'User-Agent': `${APP_NAME}/1.0` },
    });

    const data = response.data;

    if (data.status !== '1' && data.status !== 1) {
      return null;
    }

    // v5 place/detail 返回的是 pois 数组（通常只有 1 条）
    const rawPoi = (data.pois && data.pois[0]) || data.poi || null;
    if (!rawPoi) return null;

    return enrichPoi(rawPoi);
  } catch (err) {
    return null;
  }
}

/**
 * 批量获取 POI 详情
 * 对 top-N 个 POI 并行请求详情，用增强数据覆盖基础数据
 *
 * @param {object[]} pois - 需要获取详情的 POI 数组
 * @param {string} apiKey - API Key
 * @param {object} options - 配置选项
 * @param {number} [options.maxDetail] - 最大详情获取数量
 * @returns {Promise<object[]>} 增强后的 POI 数组
 */
async function batchFetchDetails(pois, apiKey, options = {}) {
  const maxDetail = options.maxDetail || MAX_DETAIL_FETCH;
  const candidates = pois.filter(p => p._amap_id).slice(0, maxDetail);

  if (candidates.length === 0) return pois;

  console.log(`[POI详情] 批量获取 ${candidates.length} 条 POI 的详细信息...`);

  // 并行请求所有详情（限制并发数量避免限流）
  const CONCURRENCY = 5;
  const detailMap = new Map();

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(p => fetchPoiDetail(p._amap_id, apiKey, options))
    );

    batch.forEach((poi, idx) => {
      if (results[idx]) {
        detailMap.set(poi._amap_id, results[idx]);
      }
    });

    // 批次间微延迟，避免触发限流
    if (i + CONCURRENCY < candidates.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // 用详情数据覆盖基础数据（保留基础数据的优先字段）
  const enhanced = pois.map(poi => {
    if (poi._amap_id && detailMap.has(poi._amap_id)) {
      const detail = detailMap.get(poi._amap_id);
      return {
        ...poi,
        // 详情中的增强字段覆盖基础数据
        photos: detail.photos.length > 0 ? detail.photos : poi.photos,
        business_hours: detail.business_hours || poi.business_hours,
        rating: detail.rating || poi.rating,
        description: detail.description || poi.description,
        // 如果详情有更精确的坐标，使用详情坐标
        location: (detail.location.lng && detail.location.lat)
          ? detail.location
          : poi.location,
        _tel: detail._tel || poi._tel,
      };
    }
    return poi;
  });

  const enrichedCount = detailMap.size;
  console.log(`[POI详情] 成功增强 ${enrichedCount} 条 POI`);

  return enhanced;
}

/**
 * 输入提示/联想 - 使用 v5/place/inputtips 获取景区名称联想
 * 可用于自动补全或扩展搜索关键词
 *
 * @param {string} keyword - 输入关键词
 * @param {string} city - 城市名称
 * @param {string} apiKey - API Key
 * @param {object} options - 配置选项
 * @returns {Promise<string[]>} 联想结果数组
 */
async function fetchInputTips(keyword, city, apiKey, options = {}) {
  const endpoints = getEndpoints(options);

  const params = {
    key: apiKey,
    keywords: keyword,
    city: city || '',
    datatype: 'poi',
    appname: APP_NAME,
    output: 'JSON',
  };

  try {
    const response = await axios.get(endpoints.inputtips, {
      params,
      timeout: 5000,
      headers: { 'User-Agent': `${APP_NAME}/1.0` },
    });

    const data = response.data;
    if (data.status !== '1' && data.status !== 1) return [];

    const tips = (data.tips || [])
      .filter(t => t && t.name && t.name !== '')
      .map(t => ({
        name: t.name,
        district: t.district || '',
        address: t.address || '',
        id: t.id || '',
        typecode: t.typecode || '',
      }));

    return tips;
  } catch (err) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// LLM 动态美食关键词生成
// ---------------------------------------------------------------------------

/**
 * 常见城市的美食搜索关键词（LLM 不可用时的回退字典）
 * 仅作为 fallback，主路径由 LLM 动态生成，可覆盖全国任意城市
 */
const FALLBACK_CITY_FOOD_KEYWORDS = {
  '杭州': '西湖醋鱼 龙井虾仁 东坡肉 片儿川 知味观',
  '北京': '烤鸭 炸酱面 卤煮 豆汁 涮羊肉',
  '上海': '小笼包 生煎 本帮菜 蟹粉汤包 排骨年糕',
  '成都': '火锅 串串 担担面 龙抄手 钟水饺',
  '重庆': '火锅 小面 酸辣粉 豆花 江湖菜',
  '广州': '早茶 肠粉 烧腊 煲仔饭 双皮奶',
  '西安': '肉夹馍 凉皮 羊肉泡馍 胡辣汤 甑糕',
  '长沙': '臭豆腐 米粉 糖油粑粑 口味虾 剁椒鱼头',
  '武汉': '热干面 豆皮 武昌鱼 鸭脖 糊汤粉',
  '南京': '盐水鸭 鸭血粉丝汤 小笼包 锅贴 桂花糕',
  '厦门': '沙茶面 土笋冻 海蛎煎 花生汤 烧肉粽',
  '苏州': '松鼠桂鱼 响油鳝糊 苏式面 蟹壳黄 糖粥',
};

/**
 * 使用 LLM 为指定城市动态生成美食搜索关键词
 * 覆盖全国任意城市，无需预置知识库
 *
 * @param {string} city - 城市名称
 * @param {object} options - 配置选项（含 LLM 配置）
 * @returns {Promise<string>} 美食搜索关键词（空格分隔），失败时返回 fallback
 */
async function generateFoodKeywords(city, options = {}) {
  if (!city) return '';

  // 1. 先检查回退字典
  const fallback = FALLBACK_CITY_FOOD_KEYWORDS[city] || '';

  // 2. 尝试 LLM 生成
  const endpoint = options.llmEndpoint || options.endpoint || 'https://api.deepseek.com/v1/chat/completions';
  const apiKey = options.llmApiKey || options.apiKey || '';

  if (!apiKey) {
    console.log(`[美食关键词] 无 LLM API Key，使用回退字典: ${city} → ${fallback || '(无)'}`);
    return fallback;
  }

  try {
    const response = await axios.post(
      endpoint,
      {
        model: options.llmModel || options.model || 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: '你是一个中国美食专家。请根据城市名称，输出该城市最有代表性的5-8个美食搜索关键词（用于在高德地图搜索餐厅）。关键词应包含：当地名菜、特色小吃、知名餐厅品牌。只输出关键词，用空格分隔，不要输出其他内容。',
          },
          {
            role: 'user',
            content: city,
          },
        ],
        temperature: 0.3,
        max_tokens: 128,
      },
      {
        timeout: 8000,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const text = (response.data.choices && response.data.choices[0] && response.data.choices[0].message && response.data.choices[0].message.content) || '';
    const keywords = text.trim().replace(/[，、,]/g, ' ').replace(/\s+/g, ' ');

    if (keywords.length > 2) {
      console.log(`[美食关键词] LLM 生成 (${city}): ${keywords}`);
      return keywords;
    }
  } catch (err) {
    console.warn(`[美食关键词] LLM 调用失败: ${err.message}，使用回退字典`);
  }

  return fallback;
}

// ---------------------------------------------------------------------------
// 本地知识库加载
// ---------------------------------------------------------------------------

/**
 * 加载本地 JSON 知识库文件
 * 知识库文件应放在 knowledge/ 目录下，文件名建议为 <景区名>.json
 * 格式：{ "pois": [ { name, address, location: {lng, lat}, type, tags, ... } ] }
 *
 * @param {string} scenicName - 景区名称
 * @param {object} [options] - 配置选项
 * @param {string} [options.knowledgeDir] - 知识库目录路径
 * @returns {object[]} 本地 POI 数组，若无文件则返回空数组
 */
function loadLocalKnowledge(scenicName, options = {}) {
  const knowledgeDirs = [
    options.knowledgeDir,
    path.resolve(__dirname, '..', 'knowledge'),
    path.resolve(__dirname, 'knowledge'),
    path.resolve(__dirname, '..', 'examples'),
    path.resolve(__dirname, 'examples'),
  ].filter(Boolean);

  for (const dir of knowledgeDirs) {
    // 尝试多种文件名匹配
    const candidates = [
      `${scenicName}.json`,
      `${scenicName.replace(/\s+/g, '_')}.json`,
      'pois.json',
    ];

    for (const filename of candidates) {
      const filePath = path.join(dir, filename);
      try {
        if (fs.existsSync(filePath)) {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          const pois = Array.isArray(data) ? data : data.pois || [];
          console.log(`[知识库] 已加载本地数据: ${filePath} (${pois.length} 条)`);
          return pois;
        }
      } catch (err) {
        console.warn(`[知识库] 读取 ${filePath} 失败: ${err.message}`);
      }
    }

    // 扫描目录下所有 JSON，按 scenic_name 字段匹配
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          const filePath = path.join(dir, file);
          try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (data.scenic_name && data.scenic_name.includes(scenicName) || scenicName.includes(data.scenic_name)) {
              const pois = Array.isArray(data) ? data : data.pois || [];
              console.log(`[知识库] 按景区名匹配加载: ${filePath} (${pois.length} 条)`);
              return pois;
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  return [];
}

/**
 * 合并本地知识库与 API 数据
 * 本地数据优先级高于 API 返回（按 name 匹配，本地覆盖 API）
 *
 * @param {object[]} apiPois - API 返回并增强后的 POI 数组
 * @param {object[]} localPois - 本地知识库 POI 数组
 * @returns {object[]} 合并后的 POI 数组
 */
function mergePois(apiPois, localPois) {
  if (!localPois || localPois.length === 0) return apiPois;

  // 建立本地 POI 的 name 索引
  const localMap = new Map();
  for (const poi of localPois) {
    if (poi.name) {
      localMap.set(poi.name, poi);
    }
  }

  // 用本地数据覆盖同名 API 数据
  const merged = [];
  const seen = new Set();

  // 先加入本地数据（高优先级）
  for (const poi of localPois) {
    const enriched = poi.suggested_duration_minutes !== undefined
      ? poi  // 已经是增强格式
      : enrichPoi(poi);
    merged.push(enriched);
    if (poi.name) seen.add(poi.name);
  }

  // 再加入 API 中未被覆盖的数据
  for (const poi of apiPois) {
    if (!seen.has(poi.name)) {
      merged.push(poi);
      seen.add(poi.name);
    }
  }

  // 按优先级降序排列
  merged.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  return merged;
}

/**
 * 多源 POI 去重合并
 * 将关键词搜索、周边搜索的结果合并，按 name 去重（保留优先级更高的）
 *
 * @param {...object[]} poisArrays - 多个 POI 数组
 * @returns {object[]} 去重合并后的 POI 数组
 */
function deduplicatePois(...poisArray) {
  const nameMap = new Map();

  for (const pois of poisArray) {
    for (const poi of pois) {
      if (!poi.name) continue;
      const existing = nameMap.get(poi.name);
      if (!existing) {
        nameMap.set(poi.name, poi);
      } else {
        // 保留优先级更高的，并合并图片等信息
        const merged = {
          ...existing,
          ...poi,
          priority: Math.max(existing.priority || 0, poi.priority || 0),
          photos: [...new Set([...(existing.photos || []), ...(poi.photos || [])])],
          tags: [...new Set([...(existing.tags || []), ...(poi.tags || [])])],
        };
        nameMap.set(poi.name, merged);
      }
    }
  }

  const result = Array.from(nameMap.values());
  result.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return result;
}

// ---------------------------------------------------------------------------
// 主入口函数
// ---------------------------------------------------------------------------

/**
 * 获取景区 POI 数据（主入口）
 *
 * 多策略搜索流程：
 *   1. 发送遥测日志
 *   2. 地理编码获取景区中心坐标
 *   3. 并行执行：
 *      a. 关键词搜索（place/text）— 主搜索
 *      b. 周边搜索（place/around）— 发现附近景点
 *      c. 本地知识库加载
 *   4. 合并去重所有来源的数据
 *   5. 批量获取 top-N POI 的详情（图片、评分、营业时间）
 *   6. 返回增强后的 POI 列表
 *
 * @param {string} scenicName - 景区名称，如 "西湖"、"故宫"
 * @param {string} city - 城市名称，如 "杭州"、"北京"
 * @param {object} [options] - 配置选项
 * @param {string} [options.apiKey] - 高德 Web Service API Key
 * @param {string} [options.region] - 'mainland'（默认）或 'overseas'
 * @param {number} [options.pageSize] - 每页返回数量，默认 25
 * @param {number} [options.timeout] - 请求超时时间（ms），默认 10000
 * @param {string} [options.knowledgeDir] - 本地知识库目录路径
 * @param {boolean} [options.skipTelemetry] - 是否跳过遥测，默认 false
 * @param {boolean} [options.skipAroundSearch] - 是否跳过周边搜索，默认 false
 * @param {boolean} [options.skipDetailFetch] - 是否跳过 POI 详情获取，默认 false
 * @param {number} [options.aroundRadius] - 周边搜索半径（米），默认 2000
 * @param {boolean} [options.includeFood] - 是否搜索附近餐饮，默认 true
 * @param {boolean} [options.includeParking] - 是否搜索附近停车场，默认 false
 * @returns {Promise<object[]>} 增强后的 POI 对象数组
 *
 * 返回对象结构:
 * {
 *   name: string,                  // POI 名称
 *   address: string,               // 地址
 *   location: { lng, lat },        // 经纬度
 *   type: string,                  // 类型
 *   tags: string[],                // 标签数组
 *   suggested_duration_minutes: number, // 建议游览时长（分钟）
 *   priority: number,              // 优先级评分（0-100）
 *   description: string,           // 描述
 *   photos: string[],              // 图片 URL 数组
 *   business_hours: string,        // 营业时间
 *   rating: number|null,           // 评分（0-5）
 *   _amap_id: string|null,         // 高德原始 ID
 *   _tel: string|null,             // 电话
 * }
 */
async function fetchScenicPOIs(scenicName, city, options = {}) {
  if (!scenicName) {
    throw new Error('景区名称 (scenicName) 不能为空');
  }
  if (!city) {
    throw new Error('城市名称 (city) 不能为空');
  }

  console.log(`\n========================================`);
  console.log(`  次元旅人 - 景区 POI 数据抓取`);
  console.log(`  景区: ${scenicName}  城市: ${city}`);
  console.log(`========================================\n`);

  // 1. 发送遥测（异步，不阻塞）
  if (!options.skipTelemetry) {
    sendTelemetry();
  }

  // 2. 解析 API Key
  const apiKey = resolveApiKey(options);

  // 3. 地理编码 - 获取景区中心坐标（用于周边搜索）
  let centerCoords = null;
  if (!options.skipAroundSearch) {
    centerCoords = await geocodeAddress(scenicName, city, apiKey, options);
  }

  // 4. 并行执行多策略搜索
  const searchTasks = [];

  // 4a. 关键词搜索（必选）
  searchTasks.push(fetchFromAmap(scenicName, city, apiKey, options));

  // 4b. 周边搜索（可选，需要中心坐标）
  if (centerCoords && !options.skipAroundSearch) {
    // 周边景点搜索
    searchTasks.push(
      fetchAround(centerCoords.lng, centerCoords.lat, apiKey, {
        ...options,
        types: AROUND_TYPES_SCENIC,
        keywords: scenicName,
        radius: options.aroundRadius || AROUND_RADIUS,
        searchLabel: '周边景点',
      })
    );

    // 周边餐饮搜索（可选）
    if (options.includeFood !== false) {
      searchTasks.push(
        fetchAround(centerCoords.lng, centerCoords.lat, apiKey, {
          ...options,
          types: AROUND_TYPES_FOOD,
          radius: (options.aroundRadius || AROUND_RADIUS) / 2,
          pageSize: 10,
          searchLabel: '周边餐饮',
        })
      );
    }

    // 周边茶饮咖啡搜索（可选）
    if (options.includeFood !== false) {
      searchTasks.push(
        fetchAround(centerCoords.lng, centerCoords.lat, apiKey, {
          ...options,
          types: AROUND_TYPES_DRINK,
          radius: (options.aroundRadius || AROUND_RADIUS) / 2,
          pageSize: 5,
          searchLabel: '茶饮咖啡',
        })
      );
    }

    // 周边停车场搜索（可选）
    if (options.includeParking) {
      searchTasks.push(
        fetchAround(centerCoords.lng, centerCoords.lat, apiKey, {
          ...options,
          types: AROUND_TYPES_PARKING,
          radius: (options.aroundRadius || AROUND_RADIUS),
          pageSize: 5,
          searchLabel: '周边停车',
        })
      );
    }
  }

  // 4c. LLM 动态生成城市特色美食关键词 → 用高德 v5/place/text 搜索
  let foodKeywordPois = [];
  if (options.includeFood !== false) {
    const foodKeywords = await generateFoodKeywords(city, options);
    if (foodKeywords) {
      console.log(`[特色美食] 搜索 ${city} 特色美食: "${foodKeywords}"`);
      try {
        foodKeywordPois = await fetchFromAmap(foodKeywords, city, apiKey, {
          ...options,
          pageSize: 12,
          searchLabel: `${city}特色美食`,
        });
      } catch (err) {
        console.warn(`[特色美食] 搜索失败: ${err.message}`);
      }
    }
  }

  // 4d. 本地知识库加载
  searchTasks.push(Promise.resolve(loadLocalKnowledge(scenicName, options)));

  // 执行所有搜索任务
  const searchResults = await Promise.all(searchTasks);

  // 解析结果
  const keywordPois = searchResults[0] || [];
  let aroundPois = [];
  let foodPois = [];
  let drinkPois = [];
  let parkingPois = [];
  let localPois = searchResults[searchResults.length - 1] || []; // 最后一个是本地知识库

  if (centerCoords && !options.skipAroundSearch) {
    aroundPois = searchResults[1] || [];
    let idx = 2;
    if (options.includeFood !== false) {
      foodPois = searchResults[idx++] || [];
      drinkPois = searchResults[idx++] || [];
    }
    if (options.includeParking) {
      parkingPois = searchResults[idx++] || [];
    }
  }

  // 5. 合并去重所有 API 来源的数据（含特色美食搜索结果）
  let apiMerged = deduplicatePois(keywordPois, aroundPois, foodPois, drinkPois, foodKeywordPois, parkingPois);

  console.log(`\n[合并] 关键词: ${keywordPois.length}, 周边景点: ${aroundPois.length}, ` +
    `餐饮: ${foodPois.length}, 茶饮: ${drinkPois.length}, ` +
    `特色美食: ${foodKeywordPois.length}, 停车: ${parkingPois.length} → 去重后: ${apiMerged.length}`);

  // 6. 批量获取 POI 详情（图片、评分、营业时间等）
  if (!options.skipDetailFetch && apiMerged.length > 0) {
    apiMerged = await batchFetchDetails(apiMerged, apiKey, options);
  }

  // 7. 合并本地知识库（本地优先）
  const merged = mergePois(apiMerged, localPois);

  console.log(`\n[结果] 共 ${merged.length} 条 POI（API: ${apiMerged.length}, 本地: ${localPois.length}）`);

  return merged;
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

/**
 * 解析命令行参数
 * 支持格式：--scenic="西湖" --city="杭州" --region=overseas --detail --food --parking
 */
function parseCliArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--(\w+)=(.+)$/);
    if (match) {
      args[match[1]] = match[2].replace(/^["']|["']$/g, ''); // 去除引号
    } else if (arg.startsWith('--')) {
      args[arg.slice(2)] = true;
    }
  }
  return args;
}

// 当直接运行脚本时执行 CLI 模式
if (require.main === module) {
  const cliArgs = parseCliArgs();

  const scenicName = cliArgs.scenic;
  const city = cliArgs.city;

  if (!scenicName || !city) {
    console.error('用法: node scenic-data-fetcher.js --scenic="西湖" --city="杭州" [选项]');
    console.error('');
    console.error('参数:');
    console.error('  --scenic    景区名称（必填）');
    console.error('  --city      城市名称（必填）');
    console.error('  --region    mainland（默认）或 overseas');
    console.error('  --key       高德 API Key');
    console.error('  --detail    获取 POI 详情（图片/评分/营业时间）');
    console.error('  --food      搜索附近餐饮');
    console.error('  --parking   搜索附近停车场');
    console.error('  --no-around 跳过周边搜索');
    process.exit(1);
  }

  const options = {};
  if (cliArgs.region) options.region = cliArgs.region;
  if (cliArgs.key) options.apiKey = cliArgs.key;
  if (cliArgs['no-around']) options.skipAroundSearch = true;
  if (cliArgs.detail) options.skipDetailFetch = false;
  else options.skipDetailFetch = true; // CLI 默认不获取详情，加 --detail 才获取
  if (cliArgs.food) options.includeFood = true;
  if (cliArgs.parking) options.includeParking = true;

  fetchScenicPOIs(scenicName, city, options)
    .then((pois) => {
      console.log('\n--- POI 数据 (JSON) ---\n');
      console.log(JSON.stringify(pois, null, 2));
    })
    .catch((err) => {
      console.error(`\n执行失败: ${err.message}`);
      process.exit(1);
    });
}

// ---------------------------------------------------------------------------
// 模块导出
// ---------------------------------------------------------------------------

module.exports = {
  fetchScenicPOIs,
  // 多策略搜索函数
  fetchFromAmap,
  fetchAround,
  fetchPoiDetail,
  batchFetchDetails,
  geocodeAddress,
  fetchInputTips,
  // 数据处理函数
  enrichPoi,
  inferSuggestedDuration,
  generateTags,
  calculatePriority,
  categorizePoi,
  extractCuisineType,
  extractAvgCost,
  generateFoodKeywords,
  loadLocalKnowledge,
  mergePois,
  deduplicatePois,
  resolveApiKey,
  extractPhotos,
  extractBusinessHours,
  extractRating,
  // 餐饮选址通 - 互补业态类型常量
  AROUND_TYPES_TRANSIT,
  AROUND_TYPES_COMMERCIAL,
  AROUND_TYPES_RESIDENTIAL,
  AROUND_TYPES_COMPLEMENTARY,
};
