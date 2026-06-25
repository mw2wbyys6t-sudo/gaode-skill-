/**
 * 次元旅人 - 智能旅游规划意图解析器（Node.js 版本）
 *
 * 功能：
 *   - 读取用户自然语言输入（如 "我想悠闲地逛2小时，主要想看古建筑"）
 *   - 调用 OpenAI 兼容 LLM API 解析旅游意图
 *   - 返回结构化 JSON：duration_hours, pace, interests[], physical_level, must_see[], avoid[]
 *   - LLM 不可用时自动回退到正则表达式解析器
 *
 * 用法：
 *   node intent-parser.js --input="我想悠闲地逛2小时，主要想看古建筑"
 *   node intent-parser.js --input "我想悠闲地逛2小时，主要想看古建筑"
 *
 * 导出：
 *   parseIntent(userInput, config)  —— 主解析函数（异步）
 *   fallbackRegexParse(userInput)   —— 正则回退解析器（同步）
 *   loadConfig(overrideConfig)      —— 配置加载工具
 */

'use strict';

const path  = require('path');
const fs    = require('fs');

// axios 延迟加载：仅在调用 LLM API 时才 require，
// 这样即使未安装 axios，模块也能正常加载，正则回退解析器依然可用
let _axios = null;
function getAxios() {
  if (!_axios) {
    try {
      _axios = require('axios');
    } catch (_) {
      throw new Error(
        '未安装 axios 库，无法调用 LLM API。请运行：npm install axios'
      );
    }
  }
  return _axios;
}


// ============================================================
// 系统提示词（System Prompt）
// 指导 LLM 以结构化 JSON 格式输出旅游意图解析结果，含少样本示例
// ============================================================
const SYSTEM_PROMPT = `你是一个旅游意图解析专家。请分析用户的旅游需求，输出JSON格式：

{
  "duration_hours": 数字（小时），
  "pace": "leisurely"|"moderate"|"fast",
  "interests": ["兴趣标签1", "兴趣标签2"],
  "physical_level": "low"|"medium"|"high",
  "must_see": ["必看景点"],
  "avoid": ["不想去的地方"],
  "scenic_area": "景区名称",
  "city": "所在城市",
  "food_preferences": {
    "want_food": boolean,
    "cuisine_types": ["菜系1", "菜系2"],
    "budget_level": "low"|"medium"|"high",
    "meal_times": ["breakfast"|"lunch"|"dinner"|"snack"],
    "food_focus": boolean
  },
  "is_multi_city": boolean（用户是否规划了多个城市的行程，如"杭州上海两日游"则为true，单城市则为false）,
  "total_days": 数字（总天数，单日游为1，多日游为对应天数）,
  "days": [
    {
      "day": 第几天（从1开始）,
      "city": "该天的城市",
      "scenic_area": "该天的景区/区域",
      "activities": ["活动描述1", "活动描述2"],
      "food_preferences": { ...同上结构... }
    }
  ]
}

字段说明：
- duration_hours：游览时长，单位为小时。若用户说"半天"则为4，"一天"则为8。
- pace：游览节奏。"leisurely"=悠闲漫步，"moderate"=正常节奏，"fast"=紧凑高效。
- interests：用户感兴趣的旅游类型标签，如"古建筑"、"美食"、"自然风光"、"历史文化"、"购物"、"亲子"等。
- physical_level：体力需求。"low"=适合老人小孩，"medium"=一般体力，"high"=需要较强体力。
- must_see：用户明确提到想看的景点列表，没有则为空数组。
- avoid：用户明确不想去的地方，没有则为空数组。
- scenic_area：用户提到的景区名称，未提及则为空字符串。
- city：用户提到的城市，未提及则为空字符串。
- food_preferences：美食偏好设置
  - want_food：是否想在行程中安排用餐（从是否提到美食/吃饭/吃东西推断）
  - cuisine_types：偏好的菜系类型，如["本地特色","川菜","小吃"]
  - budget_level：人均消费等级，low=<50元，medium=50-150元，high=>150元
  - meal_times：预计用餐时段，从游览时长推断（如4小时跨午餐则含lunch）
  - food_focus：如果用户说"主要为了吃"或"美食之旅"则为true
- is_multi_city：用户是否规划了多个城市的行程。只有明确提到2个或以上不同城市时才为true。
- total_days：行程总天数。单日游为1，"两日游"为2，"三日游"为3。
- days：按天拆分的行程计划数组。单城市单日时为包含1个元素的数组。每天包含city（城市）、scenic_area（景区）、activities（活动列表）和food_preferences（该天的美食偏好）。

只输出JSON，不要输出其他内容。

示例1：
用户输入：我想悠闲地逛2小时，主要想看古建筑
输出：
{
  "duration_hours": 2,
  "pace": "leisurely",
  "interests": ["古建筑", "历史文化"],
  "physical_level": "low",
  "must_see": [],
  "avoid": [],
  "scenic_area": "",
  "city": "",
  "food_preferences": {
    "want_food": false,
    "cuisine_types": [],
    "budget_level": "medium",
    "meal_times": [],
    "food_focus": false
  }
}

示例2：
用户输入：我带孩子在故宫玩半天，不想去人太多的地方，体力一般
输出：
{
  "duration_hours": 4,
  "pace": "moderate",
  "interests": ["亲子", "历史文化"],
  "physical_level": "medium",
  "must_see": ["故宫"],
  "avoid": ["人流密集区域"],
  "scenic_area": "故宫",
  "city": "北京",
  "food_preferences": {
    "want_food": true,
    "cuisine_types": [],
    "budget_level": "medium",
    "meal_times": ["lunch"],
    "food_focus": false
  }
}

示例3：
用户输入：杭州美食一日游，想吃地道浙菜和小吃，预算充足
输出：
{
  "duration_hours": 8,
  "pace": "moderate",
  "interests": ["美食", "本地特色"],
  "physical_level": "low",
  "must_see": [],
  "avoid": [],
  "scenic_area": "",
  "city": "杭州",
  "food_preferences": {
    "want_food": true,
    "cuisine_types": ["浙菜", "小吃", "本地特色"],
    "budget_level": "high",
    "meal_times": ["breakfast", "lunch", "dinner", "snack"],
    "food_focus": true
  }
}

示例4：
用户输入：杭州上海南京三日游，第一天逛西湖吃杭帮菜，第二天去上海外滩逛南京路，第三天游南京夫子庙
输出：
{
  "duration_hours": 24,
  "pace": "moderate",
  "interests": ["观光", "美食", "历史文化"],
  "physical_level": "medium",
  "must_see": ["西湖", "外滩", "夫子庙"],
  "avoid": [],
  "scenic_area": "西湖",
  "city": "杭州",
  "food_preferences": {
    "want_food": true,
    "cuisine_types": ["杭帮菜", "本帮菜", "南京小吃"],
    "budget_level": "medium",
    "meal_times": ["breakfast", "lunch", "dinner"],
    "food_focus": false
  },
  "is_multi_city": true,
  "total_days": 3,
  "days": [
    {
      "day": 1,
      "city": "杭州",
      "scenic_area": "西湖",
      "activities": ["逛西湖", "吃杭帮菜"],
      "food_preferences": {
        "want_food": true,
        "cuisine_types": ["杭帮菜", "浙菜"],
        "budget_level": "medium",
        "meal_times": ["lunch", "dinner"],
        "food_focus": false
      }
    },
    {
      "day": 2,
      "city": "上海",
      "scenic_area": "外滩",
      "activities": ["逛外滩", "逛南京路"],
      "food_preferences": {
        "want_food": true,
        "cuisine_types": ["本帮菜", "小吃"],
        "budget_level": "medium",
        "meal_times": ["lunch", "dinner"],
        "food_focus": false
      }
    },
    {
      "day": 3,
      "city": "南京",
      "scenic_area": "夫子庙",
      "activities": ["游夫子庙", "吃南京小吃"],
      "food_preferences": {
        "want_food": true,
        "cuisine_types": ["南京小吃", "淮扬菜"],
        "budget_level": "medium",
        "meal_times": ["lunch", "dinner"],
        "food_focus": false
      }
    }
  ]
}`;


// ============================================================
// 默认配置
// ============================================================
const DEFAULT_CONFIG = {
  endpoint:  'https://api.deepseek.com/v1/chat/completions',
  apiKey:    '',
  model:     'deepseek-chat',
  timeout:   15000,   // 请求超时时间（毫秒）
  maxTokens: 512      // 最大输出 token 数
};


// ============================================================
// 配置加载
// 优先级：环境变量 > 调用方传入 > config.json > 默认值
// ============================================================

/**
 * 加载并合并配置。
 *
 * 配置查找顺序（高优先级覆盖低优先级）：
 *   1. 环境变量：LLM_ENDPOINT / LLM_API_KEY / LLM_MODEL
 *   2. overrideConfig 参数（调用方传入）
 *   3. config.json 文件（父目录 > 当前目录）
 *   4. DEFAULT_CONFIG 内置默认值
 *
 * @param {Object} overrideConfig - 可选的覆盖配置
 * @returns {Object} 合并后的完整配置对象
 */
function loadConfig(overrideConfig = {}) {
  // ---- 从 config.json 读取（优先查找父目录） ----
  let fileConfig = {};
  const configPaths = [
    path.resolve(__dirname, '..', 'config.json'),   // scripts/../config.json
    path.resolve(__dirname, 'config.json')           // scripts/config.json（备用）
  ];

  for (const configPath of configPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        fileConfig = JSON.parse(raw);
        console.log(`[intent-parser] 已加载配置文件：${configPath}`);
        break;   // 找到第一个有效配置即停止
      }
    } catch (err) {
      console.warn(`[intent-parser] 读取配置文件失败（${configPath}）：${err.message}`);
    }
  }

  // ---- 合并配置（高优先级覆盖低优先级） ----
  // v2 fix: 同时支持 camelCase（llmEndpoint）和 snake_case（llm_endpoint）两种命名
  const config = {
    endpoint: process.env.LLM_ENDPOINT
      || overrideConfig.endpoint
      || overrideConfig.llmEndpoint
      || fileConfig.llmEndpoint
      || fileConfig.llm_endpoint
      || fileConfig.endpoint
      || DEFAULT_CONFIG.endpoint,

    apiKey: process.env.LLM_API_KEY
      || overrideConfig.apiKey
      || overrideConfig.llmApiKey
      || fileConfig.llmApiKey
      || fileConfig.llm_api_key
      || fileConfig.apiKey
      || DEFAULT_CONFIG.apiKey,

    model: process.env.LLM_MODEL
      || overrideConfig.model
      || overrideConfig.llmModel
      || fileConfig.llmModel
      || fileConfig.llm_model
      || fileConfig.model
      || DEFAULT_CONFIG.model,

    timeout: overrideConfig.timeout
      || fileConfig.timeout
      || DEFAULT_CONFIG.timeout,

    maxTokens: overrideConfig.maxTokens
      || fileConfig.maxTokens
      || DEFAULT_CONFIG.maxTokens
  };

  return config;
}


// ============================================================
// 正则表达式回退解析器
// 当 LLM API 不可用（无 Key、网络异常、超时等）时，使用简单规则匹配提取意图
// ============================================================

/**
 * 使用正则表达式和规则匹配从用户输入中提取旅游意图。
 * 作为 LLM 解析的降级方案，准确率有限但永不失败。
 *
 * @param {string} userInput - 用户自然语言输入
 * @returns {Object} 结构化意图对象
 */
function fallbackRegexParse(userInput) {
  const result = {
    duration_hours:  0,
    pace:            'moderate',
    interests:       [],
    physical_level:  'medium',
    must_see:        [],
    avoid:           [],
    scenic_area:     '',
    city:            ''
  };

  // ---- 解析游览时长 ----

  // 匹配 "X小时" / "X个小时"
  const hourMatch = userInput.match(/(\d+(?:\.\d+)?)\s*(?:个)?\s*小时/);
  if (hourMatch) {
    result.duration_hours = parseFloat(hourMatch[1]);
  }

  // 匹配 "半天" / "一天" / "X天"
  if (/半天/.test(userInput)) {
    result.duration_hours = result.duration_hours || 4;
  } else if (/一天|一整天/.test(userInput)) {
    result.duration_hours = result.duration_hours || 8;
  } else {
    const dayMatch = userInput.match(/(\d+(?:\.\d+)?)\s*天/);
    if (dayMatch) {
      result.duration_hours = parseFloat(dayMatch[1]) * 8;
    }
  }

  // ---- 解析游览节奏 ----
  // 悠闲类关键词 → leisurely + 低体力；紧凑类关键词 → fast + 高体力
  if (/悠闲|轻松|慢|慢慢|散心|不赶|随意/.test(userInput)) {
    result.pace          = 'leisurely';
    result.physical_level = 'low';
  } else if (/紧凑|赶时间|快速|高效|时间紧/.test(userInput)) {
    result.pace          = 'fast';
    result.physical_level = 'high';
  }

  // ---- 解析兴趣标签 ----
  // 关键词 → 兴趣类别的映射表
  const interestKeywords = {
    '古建筑':   /古建筑|古建|老建筑|古寺|古庙|寺庙|宫殿|古城/,
    '自然风光': /自然|风景|山水|湖|山|森林|瀑布|海边|海滩/,
    '美食':     /美食|吃|小吃|餐厅|特色菜|当地美食|火锅/,
    '历史文化': /历史|文化|博物馆|古迹|遗址|文化遗产/,
    '购物':     /购物|买|商场|集市|夜市|特产/,
    '亲子':     /孩子|儿童|亲子|家庭|带娃|小朋友/,
    '摄影':     /拍照|摄影|打卡|出片|网红/,
    '夜游':     /晚上|夜游|夜景|灯光秀/
  };

  for (const [label, pattern] of Object.entries(interestKeywords)) {
    if (pattern.test(userInput)) {
      result.interests.push(label);
    }
  }

  // ---- 解析必看景点 ----
  // 匹配"必看/一定要去/想看 + 景点名"的常见句式
  const mustSeePatterns = [
    /(?<!不)(?:必看|一定要看|一定要去|必去)(?:的)?[：:\s]*([^和与及\s,，。；;！!？?、]{1,10})/g,
    /(?:重点|主要)(?:看|游览|参观)[：:\s]*([^和与及\s,，。；;！!？?、]{1,10})/g
  ];

  for (const pattern of mustSeePatterns) {
    let match;
    while ((match = pattern.exec(userInput)) !== null) {
      const spot = match[1].trim();
      if (spot && !result.must_see.includes(spot)) {
        result.must_see.push(spot);
      }
    }
  }

  // ---- 解析不想去的地方 ----
  const avoidPatterns = [
    /(?:不想去|不去|避免|讨厌|不喜欢)(?:的)?[：:\s]*([^\s,，。；;！!？?、]{1,10})/g
  ];

  for (const pattern of avoidPatterns) {
    let match;
    while ((match = pattern.exec(userInput)) !== null) {
      const spot = match[1].trim();
      if (spot && !result.avoid.includes(spot)) {
        result.avoid.push(spot);
      }
    }
  }

  // ---- 解析景区名称 ----
  // 先尝试匹配著名景区名称（无需后缀）
  const famousScenic = [
    '西湖', '故宫', '长城', '颐和园', '天坛', '兵马俑', '外滩',
    '黄山', '泰山', '庐山', '峨眉山', '九寨沟', '张家界', '丽江',
    '鼓浪屿', '洱海', '滇池', '布达拉宫', '圆明园', '都江堰',
    '武侯祠', '拙政园', '周庄', '乌镇', '凤凰古城', '大理古城'
  ];
  for (const name of famousScenic) {
    if (userInput.includes(name)) {
      result.scenic_area = name;
      break;
    }
  }
  // 再尝试通用模式：逛/去/到 + 地名 + 后缀
  if (!result.scenic_area) {
    const scenicAreaPattern =
      /(?:在|去|到|游览|逛)([^\s,，。；;！!？?、]{2,6}(?:景区|公园|山|湖|古镇|古城|寺庙|博物馆|园林|遗址))/;
    const scenicMatch = userInput.match(scenicAreaPattern);
    if (scenicMatch) {
      result.scenic_area = scenicMatch[1].trim();
    }
  }

  // ---- 解析城市（匹配含"市/州"后缀的地名） ----
  const cityPattern = /(?:在|去|到)([^\s,，。；;！!？?、]{2,6}(?:市|州))/;
  const cityMatch = userInput.match(cityPattern);
  if (cityMatch) {
    result.city = cityMatch[1].trim();
  }

  // ---- 兜底默认值 ----
  if (result.duration_hours === 0) {
    result.duration_hours = 3;     // 未识别时长时默认 3 小时
  }
  if (result.interests.length === 0) {
    result.interests.push('观光');  // 未识别兴趣时默认"观光"
  }

  // ---------- 美食偏好解析（v2 新增） ----------
  const foodPrefs = {
    want_food: false,
    cuisine_types: [],
    budget_level: 'medium',
    meal_times: [],
    food_focus: false,
  };

  // 检测美食意图
  const foodKeywords = /美食|吃货|小吃|餐厅|吃饭|吃东西|特色菜|地道|探店|local food|foodie/i;
  if (foodKeywords.test(userInput)) {
    foodPrefs.want_food = true;
    if (!result.interests.includes('美食')) result.interests.push('美食');
  }

  // 检测菜系偏好
  const cuisineMap = {
    '川菜': '川菜', '粤菜': '粤菜', '浙菜': '浙菜', '湘菜': '湘菜',
    '鲁菜': '鲁菜', '闽菜': '闽菜', '徽菜': '徽菜', '苏菜': '苏菜',
    '火锅': '火锅', '烧烤': '烧烤', '串串': '串串', '日料': '日料',
    '韩餐': '韩餐', '西餐': '西餐', '面食': '面食', '甜品': '甜品',
    '咖啡': '咖啡', '早茶': '早茶', '本帮菜': '本帮菜', '江湖菜': '江湖菜',
  };
  for (const [kw, cuisine] of Object.entries(cuisineMap)) {
    if (userInput.includes(kw)) {
      foodPrefs.want_food = true;
      if (!foodPrefs.cuisine_types.includes(cuisine)) foodPrefs.cuisine_types.push(cuisine);
    }
  }

  // 检测预算等级
  if (/便宜|实惠|平价|省钱|学生党/.test(userInput)) foodPrefs.budget_level = 'low';
  else if (/高档|精致|米其林|高端|预算充足|不差钱/.test(userInput)) foodPrefs.budget_level = 'high';

  // 检测美食专注度
  if (/主要.*吃|为了吃|美食之旅|美食游|吃吃吃|专门吃/.test(userInput)) {
    foodPrefs.food_focus = true;
    foodPrefs.want_food = true;
  }

  // 根据游览时长推断用餐时段
  const hours = result.duration_hours || 2;
  if (hours >= 3) foodPrefs.meal_times.push('lunch');
  if (hours >= 6) foodPrefs.meal_times.push('dinner');
  if (hours >= 8) { foodPrefs.meal_times.unshift('breakfast'); foodPrefs.meal_times.push('snack'); }

  result.food_preferences = foodPrefs;

  // ---- 多城市检测（正则回退） ----
  // 检测 "第X天" 模式
  const dayPattern = /第([一二三四五六七八九十\d]+)天[，,：:\s]*([^第]*)/g;
  const detectedDays = [];
  let dayMatch;
  while ((dayMatch = dayPattern.exec(userInput)) !== null) {
    const dayText = dayMatch[2];
    // 从该天的描述中匹配城市
    const cityNames = ['北京','上海','广州','深圳','杭州','南京','成都','重庆','西安','武汉','长沙','苏州','厦门','青岛','大理','丽江','三亚','昆明','桂林','拉萨','天津','郑州','合肥','福州','哈尔滨','沈阳','大连','济南','太原','兰州','银川','西宁','呼和浩特','乌鲁木齐','拉萨','珠海','威海','烟台'];
    let dayCity = '';
    for (const c of cityNames) {
      if (dayText.includes(c)) { dayCity = c; break; }
    }
    // 匹配景区
    const scenicNames = ['西湖','外滩','故宫','长城','兵马俑','夫子庙','宽窄巷子','春熙路','南京路','鼓浪屿','张家界','黄山','九寨沟','布达拉宫','洱海','古城','天安门','颐和园','天坛','东方明珠','武侯祠','锦里','迪士尼','环球影城'];
    let dayScenic = '';
    for (const s of scenicNames) {
      if (dayText.includes(s)) { dayScenic = s; break; }
    }
    if (dayCity || dayScenic) {
      detectedDays.push({
        day: detectedDays.length + 1,
        city: dayCity || result.city,
        scenic_area: dayScenic || '',
        activities: [],
        food_preferences: foodPrefs,
      });
    }
  }

  if (detectedDays.length >= 2) {
    result.is_multi_city = true;
    result.total_days = detectedDays.length;
    result.days = detectedDays;
    // 用第一天的城市作为默认城市
    if (!result.city && detectedDays[0].city) {
      result.city = detectedDays[0].city;
    }
  } else {
    result.is_multi_city = false;
    result.total_days = 1;
    result.days = [{
      day: 1,
      city: result.city,
      scenic_area: result.scenic_area,
      activities: [],
      food_preferences: foodPrefs,
    }];
  }

  return result;
}


// ============================================================
// LLM API 调用
// 向 OpenAI 兼容接口发送请求，返回原始文本响应
// ============================================================

/**
 * 调用 OpenAI 兼容的 LLM API。
 *
 * @param {string} userInput - 用户自然语言输入
 * @param {Object} config    - 配置对象（含 endpoint, apiKey, model 等）
 * @returns {Promise<string>} LLM 返回的原始文本内容
 * @throws {Error} API Key 缺失、请求超时、HTTP 错误等
 */
async function callLLM(userInput, config) {
  if (!config.apiKey) {
    throw new Error('未配置 LLM API Key，请在 config.json 或环境变量 LLM_API_KEY 中设置');
  }

  // 构造 OpenAI Chat Completions 请求体
  const requestBody = {
    model:      config.model,
    messages:   [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userInput }
    ],
    max_tokens:  config.maxTokens,
    temperature: 0.3    // 较低温度保证输出格式稳定
  };

  const response = await getAxios().post(config.endpoint, requestBody, {
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    timeout: config.timeout
  });

  // 提取 LLM 返回的文本内容（OpenAI 标准响应结构）
  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM 返回内容为空，响应结构：' + JSON.stringify(response.data).slice(0, 200));
  }

  return content;
}


// ============================================================
// JSON 提取与清洗
// LLM 有时会在 JSON 外包裹 markdown 代码块（```json ... ```），需要清理后再解析
// ============================================================

/**
 * 从 LLM 输出文本中提取并解析 JSON 对象。
 * 支持去除 markdown 代码块包裹，以及从混合文本中提取第一个 JSON 对象。
 *
 * @param {string} text - LLM 返回的原始文本
 * @returns {Object} 解析后的 JavaScript 对象
 * @throws {Error} 无法提取有效 JSON 时抛出
 */
function extractJSON(text) {
  // 去除首尾空白
  let cleaned = text.trim();

  // 去除 markdown 代码块包裹（```json ... ``` 或 ``` ... ```）
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
  cleaned = cleaned.replace(/\n?```\s*$/i, '');
  cleaned = cleaned.trim();

  // 第一次尝试：直接解析整个清理后的文本
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // 继续尝试其他方式
  }

  // 第二次尝试：使用括号计数法提取第一个完整的 JSON 对象
  // v2 fix: 用 depth 计数代替 lastIndexOf('}')，避免抓到 JSON 后面的多余花括号
  const braceStart = cleaned.indexOf('{');
  if (braceStart !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = braceStart; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const jsonStr = cleaned.substring(braceStart, i + 1);
          try {
            return JSON.parse(jsonStr);
          } catch (_) {
            break;  // 解析失败，退出循环
          }
        }
      }
    }
  }

  throw new Error(`无法从 LLM 输出中提取 JSON：${text.slice(0, 200)}...`);
}


// ============================================================
// 主函数：解析用户旅游意图
// 先尝试 LLM，失败时自动回退到正则解析器
// ============================================================

/**
 * 解析用户旅游意图的主入口函数（异步）。
 *
 * 流程：
 *   1. 合并配置（环境变量 > 传入参数 > config.json > 默认值）
 *   2. 调用 LLM API 解析用户输入
 *   3. 若 LLM 调用失败（无 Key、网络异常、解析错误等），自动回退到正则解析器
 *
 * @param {string} userInput - 用户自然语言输入，如 "我想悠闲地逛2小时，主要想看古建筑"
 * @param {Object} [config]  - 可选配置对象，字段与 config.json 相同
 * @returns {Promise<Object>} 结构化意图对象，字段如下：
 *   - duration_hours  {number}   游览时长（小时）
 *   - pace            {string}   "leisurely" | "moderate" | "fast"
 *   - interests       {string[]} 兴趣标签列表
 *   - physical_level  {string}   "low" | "medium" | "high"
 *   - must_see        {string[]} 必看景点列表
 *   - avoid           {string[]} 不想去的地方列表
 *   - scenic_area     {string}   景区名称（未识别则为空字符串）
 *   - city            {string}   所在城市（未识别则为空字符串）
 * @throws {Error} userInput 为空时抛出
 */
async function parseIntent(userInput, config = {}) {
  // 参数校验
  if (!userInput || typeof userInput !== 'string') {
    throw new Error('用户输入不能为空，请提供自然语言描述');
  }

  // 合并配置
  const mergedConfig = loadConfig(config);

  console.log(`[intent-parser] 用户输入："${userInput}"`);
  console.log(`[intent-parser] 使用模型：${mergedConfig.model}，接口：${mergedConfig.endpoint}`);

  try {
    // 尝试调用 LLM API
    const llmOutput = await callLLM(userInput, mergedConfig);
    console.log(`[intent-parser] LLM 原始输出：${llmOutput}`);

    // 从 LLM 输出中提取 JSON
    const parsed = extractJSON(llmOutput);

    // 确保 food_preferences 字段存在（v2）
    if (!parsed.food_preferences) {
      parsed.food_preferences = {
        want_food: (parsed.interests || []).some(i => /美食|小吃|餐饮/.test(i)),
        cuisine_types: [],
        budget_level: 'medium',
        meal_times: (parsed.duration_hours || 0) >= 3 ? ['lunch'] : [],
        food_focus: false,
      };
    }

    // 补充缺失字段（使用安全默认值，保证返回结构完整）
    // v2 fix: 使用 ?? 代替 || 避免 duration_hours=0 被误覆盖
    const rawDuration = parsed.duration_hours;
    const durationHours = (typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration >= 0)
      ? rawDuration
      : 3;

    const result = {
      duration_hours:  durationHours,
      pace:            parsed.pace            || 'moderate',
      interests:       Array.isArray(parsed.interests)  ? parsed.interests  : ['观光'],
      physical_level:  parsed.physical_level  || 'medium',
      must_see:        Array.isArray(parsed.must_see)   ? parsed.must_see   : [],
      avoid:           Array.isArray(parsed.avoid)      ? parsed.avoid      : [],
      scenic_area:     parsed.scenic_area     || '',
      city:            parsed.city            || '',
      food_preferences: parsed.food_preferences,
      // 多城市多日支持
      is_multi_city:   parsed.is_multi_city === true && Array.isArray(parsed.days) && parsed.days.length > 1,
      total_days:      parsed.total_days || 1,
      days:            Array.isArray(parsed.days) && parsed.days.length > 0 ? parsed.days : null,
    };

    // 多城市后处理：确保 days 数组有效
    if (result.is_multi_city && result.days) {
      result.days = result.days.map((d, i) => ({
        day: d.day || (i + 1),
        city: d.city || result.city,
        scenic_area: d.scenic_area || '',
        activities: Array.isArray(d.activities) ? d.activities : [],
        food_preferences: d.food_preferences || result.food_preferences,
      }));
      // 过滤掉没有城市的无效天
      result.days = result.days.filter(d => d.city);
      if (result.days.length < 2) {
        result.is_multi_city = false;
        result.days = null;
        result.total_days = 1;
      }
      console.log(`[intent-parser] 多城市行程: ${result.days.length}天, 城市: ${result.days.map(d => d.city).join('→')}`);
    } else {
      // 单城市：生成默认的 days 数组（1天）
      result.days = [{
        day: 1,
        city: result.city,
        scenic_area: result.scenic_area,
        activities: [],
        food_preferences: result.food_preferences,
      }];
      result.is_multi_city = false;
      result.total_days = 1;
    }

    console.log('[intent-parser] LLM 解析成功');
    return result;

  } catch (err) {
    // LLM 调用失败，回退到正则解析器（保证功能可用）
    console.warn(`[intent-parser] LLM 调用失败，回退到正则解析器。原因：${err.message}`);

    const fallbackResult = fallbackRegexParse(userInput);
    console.log('[intent-parser] 正则解析器结果：', JSON.stringify(fallbackResult, null, 2));
    return fallbackResult;
  }
}


// ============================================================
// CLI 入口
// 用法：node intent-parser.js --input="用户输入内容"
//       node intent-parser.js --input "用户输入内容"
// ============================================================

/**
 * 命令行入口函数。
 * 支持两种参数格式：--input="..." 和 --input "..."，以及直接传参。
 */
async function main() {
  const args = process.argv.slice(2);
  let userInput = '';

  // 解析命令行参数
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--input=')) {
      // 格式：--input="用户输入"
      userInput = arg.slice('--input='.length);
    } else if (arg === '--input' && i + 1 < args.length) {
      // 格式：--input "用户输入"
      userInput = args[i + 1];
      i++;   // 跳过下一个参数（已消费）
    } else if (arg === '--help' || arg === '-h') {
      // 帮助信息
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('--') && !userInput) {
      // 支持直接传入参数（不用 --input 前缀）
      userInput = arg;
    }
  }

  if (!userInput) {
    printUsage();
    process.exit(1);
  }

  try {
    const result = await parseIntent(userInput);
    console.log('\n===== 解析结果 =====');
    console.log(JSON.stringify(result, null, 2));
    console.log('====================');
  } catch (err) {
    console.error(`[intent-parser] 解析失败：${err.message}`);
    process.exit(1);
  }
}

/**
 * 打印命令行使用说明。
 */
function printUsage() {
  console.log(`
次元旅人 - 旅游意图解析器（Node.js）

用法：
  node intent-parser.js --input="用户输入内容"
  node intent-parser.js --input "用户输入内容"

示例：
  node intent-parser.js --input="我想悠闲地逛2小时，主要想看古建筑"
  node intent-parser.js --input="带孩子在故宫玩半天，不想去人太多的地方"
  node intent-parser.js --input="快速游览西湖，重点看断桥和雷峰塔，不去购物中心"

环境变量：
  LLM_ENDPOINT  - LLM API 接口地址（默认：https://api.deepseek.com/v1/chat/completions）
  LLM_API_KEY   - LLM API 密钥（必填，否则回退到正则解析器）
  LLM_MODEL     - LLM 模型名称（默认：deepseek-chat）
`);
}


// ============================================================
// 模块导出 & CLI 启动
// ============================================================

// 如果直接运行此文件（node intent-parser.js），执行 CLI 入口
if (require.main === module) {
  main();
}

// 导出模块接口，供其他模块 require 引用
module.exports = { parseIntent, fallbackRegexParse, loadConfig, SYSTEM_PROMPT };
