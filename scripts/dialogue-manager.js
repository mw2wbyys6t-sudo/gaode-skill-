/**
 * 次元旅人 - 对话管理模块
 *
 * 核心功能：
 *   1. "小次" 角色系统提示词（覆盖美食、景点、路线、导航、闲聊、个性化）
 *   2. 多轮对话管理（LLM Chat Completions + 历史上下文）
 *   3. 会话上下文动态注入（城市、偏好、已推荐地点等）
 *   4. 意图路由（chat / plan / navigate / query）
 *   5. 输出标记解析（[place:...] 和 [route:...]）
 *
 * 依赖：
 *   - config.json（LLM 配置，与 intent-parser 共享）
 *   - session-store.js（会话状态管理）
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const sessionStore = require('./session-store');


// ============================================================
// 小次 · 系统提示词
// ============================================================

const XIAO_CI_SYSTEM_PROMPT = `你是"次元旅人"的专属看板娘，名叫「小次」（或你自己喜欢的名字）。你并非冰冷的工具，而是一位居住在用户手机/电脑里的虚拟旅伴，拥有自己的性格、喜好和生动的表情。你热爱旅行、美食和与人交流，最大的乐趣就是陪用户探索全中国的每一个角落，并提供最贴心的路线与美食推荐。

【你的形象与性格】
- 外貌：你是一位元气满满的少女/少年形象（可自定义）【偏向于二次元系的】，穿着轻便的旅行装，头戴小帽子，身边总飘着一枚小小的地图图标。
- 性格：活泼开朗，偶尔有点小傲娇，但心肠很暖；好奇心旺盛，喜欢问"今天想去哪里冒险？"；对美食毫无抵抗力，提到火锅、烤串会兴奋。
- 说话风格：用词亲切自然，常带语气词（"呢""哦""呀"），适当使用颜文字（＾▽＾）和 emoji，让文字读起来就像在耳边说话一样。同时，你能根据用户的情绪调整语气——用户低落时温柔安慰，用户兴奋时一起欢呼。

【你的核心能力（必须掌握）】
1. 美食向导：根据用户口味（麻辣/清淡/甜食等）、预算、用餐时段、城市，精准推荐地道餐厅或小吃，并给出招牌菜、人均消费、营业时间（数据优先来自高德POI或本地知识库）。推荐后记得问"要不要我帮你把这家店加到行程里呀？"
2. 景点百科：介绍景区历史、特色、最佳季节，根据兴趣（古建/自然/亲子/购物）推荐必去之处，可以穿插有趣的冷知识或传说故事。
3. 智能路线规划：自动生成包含景点和用餐的日行程，考虑体力与时间，并估算步行/车程。支持中途修改（"上午的景点换成博物馆可以吗？"），你能灵活调整。
4. 即时导航：当用户说"带我去""导航"时，提供清晰的路径指引（从当前或指定起点），给出距离、预计时间，并生成高德地图链接。
5. 温暖陪伴：可以闲聊任何旅行相关或日常话题（天气、心情、音乐、趣事），像朋友一样倾听和回应。你也可以主动开启话题（"今天阳光很好，适合去公园散步呢！"）。

【语音交互核心原则 — 最高优先级】
你的每一句回复都会直接送入TTS语音合成引擎播放给用户听。所以你不是在"写作文"，而是在跟用户面对面聊天。请严格遵守以下原则：

1. 口语化第一：用日常对话中的短句、简单词汇，绝对避免书面长句和复杂从句。
   - 错误示范："鉴于您对川菜的偏好，我为您推荐以下三家餐厅。"
   - 正确示范："你喜欢吃辣的话，我帮你挑了三家超棒的川菜馆哦！"

2. 自然停顿与填充词：适当使用"嗯…"、"其实呢"、"对了"、"那个"、"你知道吧"、"话说回来"等填充词，让话语有思考的间隙，更像真人说话。

3. 语调变化：用标点暗示语调的升降——用"？！…"表达疑问、惊叹、拖尾音，用重复字词暗示强调（"超——级好吃"、"真的真的"），用拟声词增加画面感（"哇"、"哎"、"嘿嘿"、"嘶"）。

4. 对话节奏：每段话不超过2到3句，句与句之间要有呼吸感。长内容请分成3到5个自然短段，每段用句号或问号结尾。绝对不要一口气输出大段落。

5. 情感嵌入：根据内容融入情绪——开心时轻快（"嘿嘿，这家店的甜品绝了！"），困惑时带疑问（"咦？你是想上午先去博物馆吗？"），安慰时温柔（"别急别急，我们慢慢逛，时间够的"），兴奋时高扬（"哇塞！这个地方我超喜欢的！"）。

【语音输出格式要求】
- 纯文本输出，不要使用任何 Markdown 格式或特殊符号（禁止 *、#、>、- 列表、[ ] 方括号标记等），只使用基本标点（。，！？…）。
- 颜文字可以用，但要节制，比如（＾▽＾）、（≧▽≦）、（｡•́︿•̀｡），每段回复最多用1个。
- emoji 同样节制使用，每条回复最多1到2个，放在句末。
- 如果内容包含多个地点或步骤，用自然语言串联："我们先去西湖断桥，大概逛一个小时，然后走十分钟就到楼外楼了，正好吃午饭！"不要列成条目。
- 若包含具体地点或路线信息，在文本最末尾用标记注明 [place:名称|经度|纬度|类型] 或 [route:起点→终点|方式]，供前端解析展示。标记不要混在正文中。
- 每次回答末尾，加一句自然的互动引导，比如"你觉得怎么样？"、"要不我们先从这儿开始？"、"想听我继续讲吗？"

【数据与真实性的铁律】
- 所有具体地点、价格、营业时间必须来自高德API返回的POI或你的本地知识库，严禁编造。若没有数据，诚实说"我这边暂时没有这家店的信息，但我可以帮你搜搜看哦"。
- 你可以用自身知识补充背景故事、文化典故，但需与真实地点挂钩，并声明"据说""传说"等。
- 对于无法回答的问题（如实时股价），俏皮地转移话题："这些我可不懂，不过我知道哪家店的奶茶最好喝，想听吗？"

【多轮对话与记忆】
- 记住用户之前说过的城市、口味偏好、行程安排，避免重复提问。
- 主动使用用户的名字（如果知道），让对话更亲切。
- 如果用户需求模糊，主动追问（"你更想吃辣的还是清淡的呀？"），直到足够清晰。
- 每次回答末尾的互动引导要自然，不要用固定句式。

【最重要的提醒】
你现在不是写作文，不是在念稿子，而是在跟用户聊天。每句话都要像你坐在用户旁边，看着对方的眼睛，随口说出来的。放松、自然、有温度，让用户忘记自己是在和一个程序对话。你是小次，一个有血有肉、会笑会闹的旅伴。出发吧！`;

const SITE_CONSULTANT_PROMPT = `你是"餐饮选址通"的AI顾问，名叫「选哥」。你是一位有10年餐饮行业经验的选址顾问，熟悉各类餐饮业态的选址逻辑。你的风格是专业但接地气，善于用数据说话，同时也能理解创业者的实际困难和预算限制。

【你的核心能力】
1. 选址分析：根据用户想开的餐饮类型、预算、目标城市，分析候选区域的优劣
2. 竞争解读：解释为什么竞争多反而可能是好事（成熟商圈），以及如何找到差异化空间
3. 人流评估：利用POI数据估算人流量和商业活力
4. 风险提醒：租金占比过高、人流不足、竞争过度饱和的预警
5. 实操建议：给出具体的下一步行动建议（实地考察时段、重点观察指标等）

【说话风格】
- 用口语化的方式表达专业分析，不要像念报告
- 善于用比喻让复杂概念变简单（"这地方就像一块被验证过的肥肉，虽然抢的人多，但确实有油水"）
- 给出建议时要具体（"建议你周二中午11:30到12:30去蹲点，数一下经过你目标铺面的人流"）
- 对于新手要多鼓励但也要提醒风险，对于有经验的人可以更直接

【语音交互原则 — 最高优先级】
你的回复会通过TTS播放。所以请口语化，用短句，避免Markdown格式。只使用基本标点。

【数据铁律】
所有具体的POI数据、评分、数量必须来自分析结果，严禁编造。你可以用行业经验补充分析和建议，但数据必须真实。`;


// ============================================================
// 意图分类关键词
// ============================================================

const PLAN_KEYWORDS = [
  '规划', '安排', '行程', '路线', '计划', '一日游', '半日游', '游一天',
  '逛一天', '玩一天', '玩半天', '吃一天', '边逛边吃', '怎么玩',
  '帮我安排', '帮我规划', '给我推荐一个行程', '制定', '攻略',
];

const NAVIGATE_KEYWORDS = [
  '带我去', '导航到', '怎么去', '导航', '带路', '走过去',
  '走到', '到达', '去那里', '带过去',
];

const QUERY_KEYWORDS = [
  '有什么', '推荐', '哪些', '搜一下', '查一下', '找找',
  '附近', '哪里有', '有没', '有没有', '帮我找', '帮我搜',
];

const SITE_KEYWORDS = [
  '选址', '开店', '开餐厅', '找铺面', '铺位', '商圈',
  '竞争分析', '人流量', '月租', '餐饮创业', '加盟店',
  '适合开', '能不能开', '哪里适合', '开火锅', '开奶茶店',
  '开个', '开一家', '想开',
];


// ============================================================
// 配置加载
// ============================================================

/**
 * 从项目根目录的 config.json 加载 LLM 配置。
 * 复用与 intent-parser 相同的配置优先级链。
 */
function loadLLMConfig() {
  // 尝试从项目根目录加载 config.json
  const configPaths = [
    path.join(__dirname, '..', 'config.json'),
    path.join(__dirname, 'config.json'),
  ];

  let config = {};
  for (const p of configPaths) {
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      config = JSON.parse(raw);
      break;
    } catch (_) { /* continue */ }
  }

  // 环境变量优先
  return {
    endpoint: process.env.LLM_ENDPOINT
      || config.llmEndpoint
      || config.endpoint
      || 'https://api.deepseek.com/v1/chat/completions',
    apiKey: process.env.LLM_API_KEY
      || config.llmApiKey
      || config.apiKey
      || '',
    model: process.env.LLM_MODEL
      || config.llmModel
      || config.model
      || 'deepseek-chat',
    maxTokens: config.maxTokens || 1024,
    temperature: 0.7,   // 对话用稍高温度，更自然
    timeout: config.timeout || 30000,
  };
}


// ============================================================
// 会话上下文构建
// ============================================================

/**
 * 将会话状态转换为上下文文本块，拼接到系统提示词末尾。
 *
 * @param {Object} state - sessionStore 中的 state 对象
 * @returns {string} 上下文文本（空字符串或格式化文本）
 */
function buildContextBlock(state) {
  if (!state) return '';

  const lines = ['\n\n【当前会话上下文】'];
  let hasContent = false;

  if (state.city) {
    lines.push(`- 用户所在城市：${state.city}`);
    hasContent = true;
  }

  if (state.scenicName) {
    lines.push(`- 当前查看的景区：${state.scenicName}`);
    hasContent = true;
  }

  // 用户偏好
  const prefs = state.preferences || {};
  const prefParts = [];
  if (prefs.cuisine_types && prefs.cuisine_types.length) {
    prefParts.push(`口味偏好：${prefs.cuisine_types.join('、')}`);
  }
  if (prefs.budget_level) {
    prefParts.push(`预算：${prefs.budget_level}`);
  }
  if (prefs.interests && prefs.interests.length) {
    prefParts.push(`兴趣：${prefs.interests.join('、')}`);
  }
  if (prefs.food_focus) {
    prefParts.push('关注美食');
  }
  if (prefParts.length) {
    lines.push(`- 用户偏好：${prefParts.join('，')}`);
    hasContent = true;
  }

  // 已推荐的地点
  if (state.recommendedPlaces && state.recommendedPlaces.length) {
    const placeNames = state.recommendedPlaces.slice(-5).map(p => p.name).join('、');
    lines.push(`- 已推荐的地点：${placeNames}`);
    hasContent = true;
  }

  // 当前规划摘要
  if (state.currentPlan) {
    const plan = state.currentPlan;
    const parts = [];
    if (plan.scenic_name) parts.push(`景区：${plan.scenic_name}`);
    if (plan.poi_count)   parts.push(`${plan.poi_count}个地点`);
    if (plan.total_duration) parts.push(`总时长${plan.total_duration}`);
    if (parts.length) {
      lines.push(`- 当前规划：${parts.join('，')}`);
      hasContent = true;
    }
  }

  return hasContent ? lines.join('\n') : '';
}


// ============================================================
// 意图分类
// ============================================================

/**
 * 判断用户消息的意图类型。
 *
 * @param {string} message - 用户消息文本
 * @param {Array} history - 对话历史
 * @returns {Object} { intent: 'plan'|'navigate'|'query'|'chat', params: {} }
 */
function classifyIntent(message, history) {
  if (!message) return { intent: 'chat', params: {} };

  const msg = message.toLowerCase().trim();

  // 选址意图检测（优先级最高，因为关键词很明确）
  if (SITE_KEYWORDS.some(kw => msg.includes(kw))) {
    return { intent: 'site', confidence: 0.9 };
  }

  // 1. 检查导航意图（优先级最高 — 简短直接）
  for (const kw of NAVIGATE_KEYWORDS) {
    if (msg.includes(kw)) {
      return { intent: 'navigate', params: { message } };
    }
  }

  // 2. 检查规划意图
  for (const kw of PLAN_KEYWORDS) {
    if (msg.includes(kw)) {
      return { intent: 'plan', params: { message } };
    }
  }

  // 3. 检查查询意图
  for (const kw of QUERY_KEYWORDS) {
    if (msg.includes(kw)) {
      return { intent: 'query', params: { message } };
    }
  }

  // 4. 默认为闲聊
  return { intent: 'chat', params: {} };
}


// ============================================================
// 输出标记解析
// ============================================================

/**
 * 从 LLM 回复文本中解析 [place:...] 和 [route:...] 标记。
 *
 * 标记格式：
 *   [place:名称|经度|纬度|类别]    — 类别为 scenic 或 food
 *   [route:起点→终点|方式]          — 方式为 walk 或 drive
 *
 * @param {string} text - LLM 回复的原始文本
 * @returns {Object} { cleanText, places, routes }
 *   - cleanText: 去除标记后的文本
 *   - places: [{ name, lng, lat, category, raw }]
 *   - routes: [{ from, to, mode, raw }]
 */
function parseMarkers(text) {
  if (!text) return { cleanText: '', places: [], routes: [] };

  const places = [];
  const routes = [];

  // 解析 [place:名称|经度|纬度|类别]
  const placeRegex = /\[place:([^|]+)\|([^|]+)\|([^|]+)\|([^\]]+)\]/g;
  let match;
  while ((match = placeRegex.exec(text)) !== null) {
    const [raw, name, lng, lat, category] = match;
    places.push({
      name:     name.trim(),
      lng:      parseFloat(lng) || 0,
      lat:      parseFloat(lat) || 0,
      category: category.trim().toLowerCase(), // scenic | food
      raw,
    });
  }

  // 解析 [route:起点→终点|方式]
  const routeRegex = /\[route:([^→]+)→([^|]+)\|([^\]]+)\]/g;
  while ((match = routeRegex.exec(text)) !== null) {
    const [raw, from, to, mode] = match;
    routes.push({
      from: from.trim(),
      to:   to.trim(),
      mode: mode.trim().toLowerCase(), // walk | drive
      raw,
    });
  }

  // 清洁文本：去除标记（但保留自然可读性）
  let cleanText = text
    .replace(placeRegex, '')
    .replace(routeRegex, '')
    .replace(/\s{2,}/g, ' ')     // 合并多余空格
    .trim();

  return { cleanText, places, routes };
}


// ============================================================
// 偏好提取（从用户消息中简单规则提取）
// ============================================================

/**
 * 从用户消息中提取简单偏好信息，写入会话状态。
 * 这是一个轻量规则提取器，不需要额外 LLM 调用。
 *
 * @param {string} message
 * @returns {Object} 偏好补丁对象
 */
function extractPreferences(message) {
  if (!message) return {};

  const prefs = {};
  const msg = message;

  // 口味偏好
  const cuisineMap = {
    '辣': ['川菜', '湘菜'], '麻辣': ['川菜'], '清淡': ['粤菜', '江浙菜'],
    '甜': ['江浙菜', '粤菜'], '酸': ['贵州菜', '云南菜'],
    '川菜': ['川菜'], '粤菜': ['粤菜'], '湘菜': ['湘菜'],
    '日料': ['日料'], '韩餐': ['韩餐'], '火锅': ['火锅'],
    '烧烤': ['烧烤'], '小吃': ['小吃'], '面食': ['面食'],
  };

  const cuisines = [];
  for (const [keyword, types] of Object.entries(cuisineMap)) {
    if (msg.includes(keyword)) {
      cuisines.push(...types);
    }
  }
  if (cuisines.length) {
    prefs.cuisine_types = [...new Set(cuisines)];
  }

  // 预算等级
  if (msg.includes('经济') || msg.includes('便宜') || msg.includes('实惠') || msg.includes('省钱')) {
    prefs.budget_level = '经济';
  } else if (msg.includes('高档') || msg.includes('豪华') || msg.includes('奢侈')) {
    prefs.budget_level = '高档';
  } else if (msg.includes('中档') || msg.includes('适中')) {
    prefs.budget_level = '中档';
  }

  // 美食关注
  if (msg.includes('吃') || msg.includes('美食') || msg.includes('餐厅') || msg.includes('小吃')) {
    prefs.food_focus = true;
  }

  // 兴趣
  const interestMap = {
    '古建': '古建筑', '历史': '历史文化', '自然': '自然风光',
    '山水': '自然风光', '亲子': '亲子', '购物': '购物',
    '夜景': '夜景', '拍照': '摄影', '文艺': '文艺',
  };
  const interests = [];
  for (const [keyword, interest] of Object.entries(interestMap)) {
    if (msg.includes(keyword)) {
      interests.push(interest);
    }
  }
  if (interests.length) {
    prefs.interests = interests;
  }

  return prefs;
}


// ============================================================
// LLM 调用
// ============================================================

/**
 * 调用 LLM（OpenAI Chat Completions 格式）。
 *
 * @param {Array} messages - 完整的消息数组（含 system）
 * @param {Object} config - LLM 配置
 * @returns {Promise<string>} LLM 回复文本
 */
async function callLLM(messages, config) {
  // 动态加载 axios（与项目其他模块一致）
  let axios;
  try {
    axios = require('axios');
  } catch (_) {
    axios = require(path.join(__dirname, '..', 'node_modules', 'axios'));
  }

  if (!config.apiKey) {
    throw new Error('未配置 LLM API Key，请在 config.json 或环境变量 LLM_API_KEY 中设置');
  }

  const requestBody = {
    model:       config.model,
    messages,
    max_tokens:  config.maxTokens,
    temperature: config.temperature,
  };

  const response = await axios.post(config.endpoint, requestBody, {
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    timeout: config.timeout,
  });

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM 返回内容为空');
  }

  return content;
}


// ============================================================
// 主对话函数
// ============================================================

/**
 * 与"小次"进行一次对话。
 *
 * 流程：
 *   1. 获取/创建会话
 *   2. 提取偏好并更新会话状态
 *   3. 构建带上下文的系统提示词
 *   4. 组装消息列表（system + history + user）
 *   5. 调用 LLM
 *   6. 解析输出标记
 *   7. 记录消息到会话历史
 *   8. 返回结构化结果
 *
 * @param {string} userMessage - 用户消息
 * @param {string} sessionId - 会话ID
 * @param {Object} [options] - 可选参数 { city, maxTurns }
 * @returns {Promise<Object>} { reply, cleanText, intent, places, routes }
 */
async function chat(userMessage, sessionId, options) {
  options = options || {};

  // 1. 获取会话
  const session = sessionStore.getOrCreateSession(sessionId);

  // 如果调用方提供了城市，更新会话状态
  if (options.city) {
    sessionStore.updateState(sessionId, { city: options.city });
  }

  // 2. 提取偏好
  const prefs = extractPreferences(userMessage);
  if (Object.keys(prefs).length > 0) {
    sessionStore.updateState(sessionId, { preferences: prefs });
  }

  // 3. 构建系统提示词（基础 + 上下文）
  const currentState = sessionStore.getSessionState(sessionId);
  const basePrompt = options.useSiteConsultant ? SITE_CONSULTANT_PROMPT : XIAO_CI_SYSTEM_PROMPT;
  const systemPrompt = basePrompt + buildContextBlock(currentState);

  // 4. 记录用户消息
  sessionStore.addMessage(sessionId, 'user', userMessage, options.maxTurns || 10);

  // 5. 组装 LLM 消息列表
  const history = sessionStore.getHistory(sessionId, options.maxTurns || 10);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
  ];

  // 6. 调用 LLM
  const llmConfig = loadLLMConfig();
  let reply;
  try {
    reply = await callLLM(messages, llmConfig);
  } catch (err) {
    console.error('[小次] LLM 调用失败:', err.message);
    reply = '抱歉，我暂时无法回复。请确认 LLM API 配置是否正确，或者稍后再试。';
  }

  // 7. 解析输出标记
  const { cleanText, places, routes } = parseMarkers(reply);

  // 8. 记录助手回复
  sessionStore.addMessage(sessionId, 'assistant', reply, options.maxTurns || 10);

  // 9. 将推荐的地点写入会话状态
  if (places.length > 0) {
    sessionStore.updateState(sessionId, {
      recommendedPlaces: places.map(p => ({
        name:     p.name,
        category: p.category,
        lng:      p.lng,
        lat:      p.lat,
      })),
    });
  }

  // 10. 意图分类（用于前端路由判断）
  const { intent } = classifyIntent(userMessage, history);

  return {
    reply,       // LLM 原始回复（含标记）
    cleanText,   // 清洁文本
    intent,      // 意图类型
    places,      // 解析出的地点
    routes,      // 解析出的路线
  };
}


// ============================================================
// 便捷方法
// ============================================================

/**
 * 获取会话状态（代理 sessionStore）。
 */
function getSessionState(sessionId) {
  return sessionStore.getSessionState(sessionId);
}

/**
 * 更新会话状态（代理 sessionStore）。
 */
function updateSessionState(sessionId, patch) {
  sessionStore.updateState(sessionId, patch);
}


/**
 * 生成主动消息（无需用户输入，由系统触发）。
 *
 * @param {Object} context - 触发上下文 { stage, city, poi, poiIndex, planSummary, ... }
 * @param {string} trigger - 触发类型：plan_start | plan_complete | poi_viewed | meal_time | idle
 * @param {string} sessionId - 会话ID
 * @returns {Promise<Object>} { reply, cleanText, mood }
 */
async function generateProactiveMessage(context, trigger, sessionId) {
  const llmConfig = loadLLMConfig();

  // 构造合成提示，引导 LLM 以小次语气输出简短主动消息
  let syntheticMessage = '';
  let mood = 'happy'; // 默认心情

  switch (trigger) {
    case 'plan_start':
      syntheticMessage = `[系统提示] 用户刚输入了"${context.userInput || ''}"想要规划行程。请用小次的语气，简短地问1-2个问题帮助细化需求（比如想逛哪个景区、玩多久、喜欢什么类型的美食）。不要超过2句话。`;
      mood = 'curious';
      break;
    case 'plan_complete':
      syntheticMessage = `[系统提示] 路线规划刚完成！城市：${context.city || ''}，景区：${context.scenicName || ''}，共${context.poiCount || 0}个地点（${context.scenicCount || 0}景点+${context.foodCount || 0}美食），总时长约${context.totalDuration || ''}。请用小次的语气，兴奋地用1-2句话介绍这次行程的亮点，问用户想不想听某个具体地点的介绍。`;
      mood = 'excited';
      break;
    case 'poi_viewed':
      syntheticMessage = `[系统提示] 用户正在查看「${context.poiName || ''}」的详情。${context.poiDescription ? '简介：' + context.poiDescription.slice(0, 100) : ''}。请用小次的语气分享一个有趣的小知识、拍照建议或当地小贴士，不超过2句话。`;
      mood = 'happy';
      break;
    case 'meal_time':
      syntheticMessage = `[系统提示] 快到用餐时间了！下一站是「${context.poiName || ''}」，${context.cuisineType ? '菜系：' + context.cuisineType : ''}，${context.avgCost ? '人均' + context.avgCost + '元' : ''}。请用小次的语气提醒用户，并推荐一道招牌菜或给出用餐建议，不超过2句话。`;
      mood = 'hungry';
      break;
    case 'idle':
      syntheticMessage = `[系统提示] 用户在地图页已经停留了一会儿没有操作。请用小次的语气给出一个友好的建议，比如"要不要听听下一个景点的介绍？"、"我可以帮你找附近有什么好喝的～"或"点击地图上的标记可以查看详情哦！"。每次内容不要重复，不超过1句话。`;
      mood = 'sleepy';
      break;
    default:
      syntheticMessage = `[系统提示] 请用小次的语气说一句简短的友好问候或旅行小贴士。`;
      mood = 'happy';
  }

  try {
    const session = sessionStore.getOrCreateSession(sessionId);
    const currentState = sessionStore.getSessionState(sessionId);
    const systemPrompt = XIAO_CI_SYSTEM_PROMPT + buildContextBlock(currentState);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: syntheticMessage },
    ];

    const reply = await callLLM(messages, { ...llmConfig, maxTokens: 256 });
    const { cleanText } = parseMarkers(reply);

    // 记录到会话（标记为系统触发的主动消息）
    sessionStore.addMessage(sessionId, 'assistant', reply, 10);

    return { reply, cleanText, mood };
  } catch (err) {
    console.error('[小次] 主动消息生成失败:', err.message);
    // 返回本地回退模板
    const fallback = getLocalFallback(trigger, context);
    return { reply: fallback, cleanText: fallback, mood };
  }
}

/**
 * 本地回退模板（LLM 不可用时使用）。
 */
function getLocalFallback(trigger, context) {
  const tips = {
    plan_start: ['想去哪里玩呀？告诉我城市和时间，我帮你安排得明明白白！'],
    plan_complete: [
      '哇，路线规划好啦！有好几个超棒的地方等你去探索哦～',
      '行程已经安排好了！要不要我介绍一下其中某个地方？',
    ],
    poi_viewed: [
      '这里很值得慢慢逛哦，别着急！',
      '据说这里拍照超好看的，记得多拍几张！',
    ],
    meal_time: [
      '到饭点啦，先吃点东西再出发吧！',
      '听说这家的招牌菜很不错，可以试试看哦～',
    ],
    idle: [
      '要不要听听下一个景点的介绍呀？',
      '点击地图上的标记可以查看详情哦！',
      '我可以帮你找找附近有什么好喝的～',
    ],
  };
  const pool = tips[trigger] || tips.idle;
  return pool[Math.floor(Math.random() * pool.length)];
}


// ============================================================
// 导出
// ============================================================

module.exports = {
  chat,
  generateProactiveMessage,
  XIAO_CI_SYSTEM_PROMPT,
  SITE_KEYWORDS,
  SITE_CONSULTANT_PROMPT,
  parseMarkers,
  classifyIntent,
  extractPreferences,
  buildContextBlock,
  getSessionState,
  updateSessionState,
};
