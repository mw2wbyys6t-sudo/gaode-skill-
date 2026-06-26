/**
 * 餐饮选址通 - 选址意图解析器
 *
 * 功能：
 *   - 从用户自然语言输入中提取餐饮选址意图
 *   - 双模式架构：LLM 主解析 + 正则表达式回退
 *   - 输出结构化 JSON：restaurant_type, city, budget_rent, target_areas, store_type 等
 *
 * 复用：
 *   - intent-parser.js 的 loadConfig() 配置加载模式
 *   - 同样的 JSON 提取与清洗工具函数
 *
 * CLI 用法：
 *   node site-intent-parser.js --input="在成都春熙路开火锅店，月租2万以内"
 *
 * 导出：
 *   parseSiteIntent(userInput, config)  —— 主解析函数（异步）
 *   fallbackSiteRegexParse(userInput)   —— 正则回退解析器（同步）
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// axios 延迟加载
let _axios = null;
function getAxios() {
  if (!_axios) {
    try { _axios = require('axios'); }
    catch (_) { throw new Error('未安装 axios，请运行：npm install axios'); }
  }
  return _axios;
}

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  endpoint: 'https://api.deepseek.com/v1/chat/completions',
  apiKey: '',
  model: 'deepseek-chat',
  timeout: 15000,
  maxTokens: 512,
};

// ---------------------------------------------------------------------------
// 系统提示词
// ---------------------------------------------------------------------------

const SITE_SYSTEM_PROMPT = `你是餐饮选址意图解析专家。请从用户输入中提取餐饮选址相关的结构化信息，输出JSON格式：

{
  "restaurant_type": "餐饮类型（火锅/川菜/湘菜/奶茶/咖啡/烧烤/快餐/面馆/日料/西餐/小吃/炸鸡/汉堡/饺子/包子/麻辣烫/冒菜/烤鱼/黄焖鸡/螺蛳粉等）",
  "city": "目标城市名称",
  "budget_rent": "月租预算（数字，单位元），未提及则为null",
  "target_areas": ["候选商圈或区域名称列表"],
  "store_type": "商场店/街边店/社区店/都可以",
  "target_customers": "目标客群描述（如白领/学生/家庭/游客等），未提及则为空字符串",
  "experience_level": "新手/有经验/未提及",
  "special_requirements": "特殊要求或偏好（如不要地下室、需要排烟管道等），无则为空字符串"
}

字段说明：
- restaurant_type：用户想开的餐饮类型，尽量具体（如"火锅"而非"中餐"）
- city：目标城市，必须从输入中推断，未提及则为空字符串
- budget_rent：月租预算，统一为元/月。"2万以内"=20000，"5000到1万"=10000（取上限）
- target_areas：用户提到的具体商圈、街道、地标区域，如["春熙路", "建设路"]
- store_type：用户偏好的店铺类型，"都可以"表示无偏好
- target_customers：从上下文推断，如提到"大学城"则推断为学生
- experience_level：用户是否有餐饮从业经验，从表述推断
- special_requirements：用户提到的任何特殊条件

只输出JSON，不要其他内容。

示例1：
用户输入：我想在成都春熙路开一家火锅店，月租2万以内
输出：
{
  "restaurant_type": "火锅",
  "city": "成都",
  "budget_rent": 20000,
  "target_areas": ["春熙路"],
  "store_type": "都可以",
  "target_customers": "",
  "experience_level": "未提及",
  "special_requirements": ""
}

示例2：
用户输入：想在长沙五一广场或者黄兴路步行街开个奶茶店，我是新手，预算不高
输出：
{
  "restaurant_type": "奶茶",
  "city": "长沙",
  "budget_rent": null,
  "target_areas": ["五一广场", "黄兴路步行街"],
  "store_type": "都可以",
  "target_customers": "",
  "experience_level": "新手",
  "special_requirements": "预算有限"
}

示例3：
用户输入：打算在大学城附近开快餐店，主要做学生生意
输出：
{
  "restaurant_type": "快餐",
  "city": "",
  "budget_rent": null,
  "target_areas": ["大学城"],
  "store_type": "社区店",
  "target_customers": "学生",
  "experience_level": "未提及",
  "special_requirements": ""
}`;

// ---------------------------------------------------------------------------
// 城市字典（复用自 intent-parser.js）
// ---------------------------------------------------------------------------

const CITY_NAMES = [
  '北京','上海','广州','深圳','杭州','南京','成都','重庆','西安','武汉',
  '长沙','苏州','厦门','青岛','大理','丽江','三亚','昆明','桂林','拉萨',
  '天津','郑州','合肥','福州','哈尔滨','沈阳','大连','济南','太原','兰州',
  '银川','西宁','呼和浩特','乌鲁木齐','珠海','威海','烟台','无锡','宁波',
  '东莞','佛山','南宁','贵阳','南昌','石家庄','海口','长春',
];

// ---------------------------------------------------------------------------
// 配置加载
// ---------------------------------------------------------------------------

function loadSiteConfig(overrideConfig = {}) {
  let fileConfig = {};
  const configPaths = [
    path.resolve(__dirname, '..', 'config.json'),
    path.resolve(__dirname, 'config.json'),
  ];
  for (const p of configPaths) {
    try {
      if (fs.existsSync(p)) { fileConfig = JSON.parse(fs.readFileSync(p, 'utf-8')); break; }
    } catch (_) { /* continue */ }
  }

  return {
    endpoint: process.env.LLM_ENDPOINT
      || overrideConfig.endpoint || overrideConfig.llmEndpoint
      || fileConfig.llmEndpoint || fileConfig.endpoint || DEFAULT_CONFIG.endpoint,
    apiKey: process.env.LLM_API_KEY
      || overrideConfig.apiKey || overrideConfig.llmApiKey
      || fileConfig.llmApiKey || fileConfig.apiKey || DEFAULT_CONFIG.apiKey,
    model: process.env.LLM_MODEL
      || overrideConfig.model || overrideConfig.llmModel
      || fileConfig.llmModel || fileConfig.model || DEFAULT_CONFIG.model,
    timeout: overrideConfig.timeout || fileConfig.timeout || DEFAULT_CONFIG.timeout,
    maxTokens: overrideConfig.maxTokens || fileConfig.maxTokens || DEFAULT_CONFIG.maxTokens,
  };
}

// ---------------------------------------------------------------------------
// JSON 提取工具（与 intent-parser.js 同款）
// ---------------------------------------------------------------------------

function extractJSON(text) {
  let cleaned = text.trim();
  // 去除 markdown 代码块
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
  cleaned = cleaned.replace(/\n?```\s*$/i, '');
  cleaned = cleaned.trim();

  // 尝试直接解析
  try { return JSON.parse(cleaned); } catch (_) {}

  // 提取第一个 { ... } 块（计数括号匹配）
  let start = cleaned.indexOf('{');
  if (start === -1) throw new Error('无法找到 JSON 对象');

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) { return JSON.parse(cleaned.slice(start, i + 1)); } }
  }
  throw new Error('无法提取完整的 JSON 对象');
}

// ---------------------------------------------------------------------------
// LLM 调用
// ---------------------------------------------------------------------------

async function callSiteLLM(userInput, config) {
  if (!config.apiKey) {
    throw new Error('未配置 LLM API Key');
  }

  const response = await getAxios().post(config.endpoint, {
    model: config.model,
    messages: [
      { role: 'system', content: SITE_SYSTEM_PROMPT },
      { role: 'user', content: userInput },
    ],
    temperature: 0.3,
    max_tokens: config.maxTokens,
  }, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    timeout: config.timeout,
  });

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 返回内容为空');
  return content;
}

// ---------------------------------------------------------------------------
// 正则回退解析器
// ---------------------------------------------------------------------------

/**
 * 使用正则表达式从用户输入中提取选址意图
 * @param {string} userInput - 用户自然语言输入
 * @returns {Object} 结构化选址意图
 */
function fallbackSiteRegexParse(userInput) {
  const result = {
    restaurant_type: '',
    city: '',
    budget_rent: null,
    target_areas: [],
    store_type: '都可以',
    target_customers: '',
    experience_level: '未提及',
    special_requirements: '',
  };

  // 餐饮类型检测
  const typeMap = {
    '火锅': '火锅', '川菜': '川菜', '湘菜': '湘菜', '粤菜': '粤菜',
    '奶茶': '奶茶', '咖啡': '咖啡', '烧烤': '烧烤', '快餐': '快餐',
    '面馆': '面馆', '面条': '面馆', '米粉': '米粉', '螺蛳粉': '螺蛳粉',
    '日料': '日料', '寿司': '日料', '西餐': '西餐', '汉堡': '汉堡',
    '炸鸡': '炸鸡', '披萨': '披萨', '饺子': '饺子', '包子': '包子',
    '麻辣烫': '麻辣烫', '冒菜': '冒菜', '烤鱼': '烤鱼', '黄焖鸡': '黄焖鸡',
    '酸菜鱼': '酸菜鱼', '烤肉': '烤肉', '串串': '串串', '小龙虾': '小龙虾',
    '甜品': '甜品', '面包': '面包', '烘焙': '烘焙', '粥店': '粥店',
    '拉面': '拉面', '牛肉面': '面馆', '小吃': '小吃', '早餐': '早餐',
    '中餐': '中餐', '饭店': '中餐', '餐厅': '中餐', '菜馆': '中餐',
  };

  for (const [kw, type] of Object.entries(typeMap)) {
    if (userInput.includes(kw)) {
      result.restaurant_type = type;
      break;
    }
  }

  // 城市检测
  for (const city of CITY_NAMES) {
    if (userInput.includes(city)) {
      result.city = city;
      break;
    }
  }

  // 月租预算提取
  const rentPatterns = [
    /月租\s*(\d+(?:\.\d+)?)\s*万/,     // 月租2万
    /(\d+(?:\.\d+)?)\s*万\s*(?:以内|以下|左右)/,  // 2万以内
    /月租\s*(\d+)\s*(?:元|块)/,          // 月租5000元
    /(\d+)\s*(?:元|块)\s*(?:以内|以下|左右)/,  // 5000元以内
    /预算\s*(\d+(?:\.\d+)?)\s*万/,       // 预算2万
    /(\d+(?:\.\d+)?)\s*(?:千|k)\s*(?:以内|以下|左右)?/i,  // 5千以内
  ];

  for (const pattern of rentPatterns) {
    const match = userInput.match(pattern);
    if (match) {
      let val = parseFloat(match[1]);
      // 如果匹配到"万"，转换为元
      if (pattern.source.includes('万')) val *= 10000;
      // 如果匹配到"千"，转换为元
      if (pattern.source.includes('千') || pattern.source.includes('k')) val *= 1000;
      result.budget_rent = Math.round(val);
      break;
    }
  }

  // 商圈/区域提取
  const areaPatterns = [
    /(?:在|去|到)(.+?)(?:附近|周边|那[边儿里]|一带)/g,
    /(.+?)(?:商圈|步行街|商业街|美食街|广场)/g,
    /(?:在|去|到)(.+?)(?:开|租|找)/g,
  ];
  const areaSet = new Set();
  for (const pattern of areaPatterns) {
    let match;
    while ((match = pattern.exec(userInput)) !== null) {
      const area = match[1].trim();
      // 过滤掉太短的或明显不是商圈的
      if (area.length >= 2 && area.length <= 10 && !area.match(/^(想|要|打算|准备|计划)/)) {
        areaSet.add(area);
      }
    }
  }
  // 常见商圈模式
  const knownAreas = userInput.match(/[\u4e00-\u9fa5]{2,6}(?:路|街|巷|坊|广场|商圈|步行街|商业街)/g);
  if (knownAreas) knownAreas.forEach(a => areaSet.add(a));

  result.target_areas = [...areaSet];

  // 店铺类型检测
  if (/商场|mall|购物中心/.test(userInput)) result.store_type = '商场店';
  else if (/街边|临街|路边|沿街/.test(userInput)) result.store_type = '街边店';
  else if (/社区|小区|居民区/.test(userInput)) result.store_type = '社区店';

  // 目标客群检测
  if (/学生|大学|学校|校园/.test(userInput)) result.target_customers = '学生';
  else if (/白领|上班族|办公|写字楼/.test(userInput)) result.target_customers = '白领';
  else if (/家庭|居民|小区|社区/.test(userInput)) result.target_customers = '家庭';
  else if (/游客|旅客|旅游/.test(userInput)) result.target_customers = '游客';

  // 经验等级检测
  if (/新手|没经验|第一次|小白|转行|跨界/.test(userInput)) result.experience_level = '新手';
  else if (/有经验|老手|做过|干过|从业/.test(userInput)) result.experience_level = '有经验';

  return result;
}

// ---------------------------------------------------------------------------
// 主解析函数
// ---------------------------------------------------------------------------

/**
 * 解析用户的餐饮选址意图
 *
 * @param {string} userInput - 用户自然语言输入
 * @param {Object} [config] - 可选配置覆盖
 * @returns {Promise<Object>} 结构化选址意图
 */
async function parseSiteIntent(userInput, config = {}) {
  const cfg = loadSiteConfig(config);

  // 尝试 LLM 解析
  if (cfg.apiKey) {
    try {
      console.log('[选址意图] 使用 LLM 解析...');
      const rawText = await callSiteLLM(userInput, cfg);
      const parsed = extractJSON(rawText);

      // 补全/修正：如果 LLM 没提取到城市但正则能提取到
      const regexResult = fallbackSiteRegexParse(userInput);
      if (!parsed.city && regexResult.city) parsed.city = regexResult.city;
      if ((!parsed.target_areas || parsed.target_areas.length === 0) && regexResult.target_areas.length > 0) {
        parsed.target_areas = regexResult.target_areas;
      }

      // 确保所有字段都有默认值
      const result = {
        restaurant_type: parsed.restaurant_type || '',
        city: parsed.city || '',
        budget_rent: parsed.budget_rent || null,
        target_areas: parsed.target_areas || [],
        store_type: parsed.store_type || '都可以',
        target_customers: parsed.target_customers || '',
        experience_level: parsed.experience_level || '未提及',
        special_requirements: parsed.special_requirements || '',
      };

      console.log(`[选址意图] LLM 解析完成: ${result.restaurant_type} | ${result.city} | ${result.target_areas.join(', ')}`);
      return result;

    } catch (err) {
      console.warn(`[选址意图] LLM 解析失败: ${err.message}，使用正则回退`);
    }
  } else {
    console.log('[选址意图] 未配置 LLM API Key，使用正则回退解析');
  }

  // 正则回退
  const result = fallbackSiteRegexParse(userInput);
  console.log(`[选址意图] 正则解析完成: ${result.restaurant_type} | ${result.city} | ${result.target_areas.join(', ')}`);
  return result;
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2).reduce((acc, arg) => {
    const [key, val] = arg.replace(/^--/, '').split('=');
    acc[key] = val;
    return acc;
  }, {});

  const input = args.input;
  if (!input) {
    console.error('用法: node site-intent-parser.js --input="在成都春熙路开火锅店，月租2万以内"');
    process.exit(1);
  }

  parseSiteIntent(input)
    .then(result => {
      console.log('\n解析结果:');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error(`解析失败: ${err.message}`);
      process.exit(1);
    });
}

// ---------------------------------------------------------------------------
// 模块导出
// ---------------------------------------------------------------------------

module.exports = {
  parseSiteIntent,
  fallbackSiteRegexParse,
  loadSiteConfig,
  extractJSON,
  CITY_NAMES,
};
