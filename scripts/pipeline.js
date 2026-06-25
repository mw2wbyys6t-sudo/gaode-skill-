/**
 * 次元旅人 - 智能旅游规划全流程管线（Node.js 入口）
 *
 * 将四个阶段串联为端到端流水线：
 *   阶段 1：意图解析      → intent-parser.js    → parseIntent()
 *   阶段 2：景区数据抓取   → scenic-data-fetcher.js → fetchScenicPOIs()
 *   阶段 3：路线优化       → route-optimizer.js   → optimizeRoute()
 *   阶段 4：地图可视化     → map-visualizer.js    → generateMap()
 *
 * CLI 用法：
 *   node pipeline.js --input="我想悠闲地逛西湖2小时，主要想看古建筑和自然风光"
 *   node pipeline.js --input "逛西湖2小时" --city 杭州 --output my-tour.html --open
 *
 * 可选参数：
 *   --input   用户自然语言输入（必填）
 *   --city    城市名称（可选，可从意图中推断）
 *   --output  输出 HTML 文件路径（默认 tour-map.html）
 *   --open    完成后自动在浏览器中打开
 *
 * 模块导出：
 *   runPipeline(userInput, options)
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ---------- 导入四个阶段的子模块 ----------
const { parseIntent }    = require('./intent-parser');
const { fetchScenicPOIs } = require('./scenic-data-fetcher');
const { optimizeRoute }   = require('./route-optimizer');
const { generateMap }     = require('./map-visualizer');
const { createFoodProvider } = require('./food-data-provider');

// ---------- 配置加载 ----------

/**
 * 加载共享配置文件 config.json（位于 scripts/ 目录）。
 * 若文件不存在则返回空对象，各模块会使用各自默认值。
 */
function loadSharedConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('⚠️  读取 config.json 失败，将使用默认配置:', err.message);
  }
  return {};
}

// ---------- 辅助函数 ----------

/**
 * 从意图解析结果中推断景区名称。
 * 优先使用 must_see 中的第一个景点，否则返回原始输入中的关键词。
 */
function extractScenicName(intent) {
  // 优先使用 scenic_area（意图解析器标准字段）
  if (intent.scenic_area) {
    return intent.scenic_area;
  }
  // 其次使用 must_see 中的第一个景点
  if (intent.must_see && intent.must_see.length > 0) {
    return intent.must_see[0];
  }
  // 回退：兼容其他可能的字段名
  return intent.scenic_name || intent.location || '';
}

/**
 * 格式化时长（分钟 → "X小时Y分钟"）
 */
function formatDuration(minutes) {
  if (!minutes && minutes !== 0) return '未知';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0 && m > 0) return `${h}小时${m}分钟`;
  if (h > 0) return `${h}小时`;
  return `${m}分钟`;
}

/**
 * 将路线优化器输出转换为地图模板期望的数据格式
 *
 * 路线优化器输出: { ordered_pois, segments, total_duration_minutes, total_walking_minutes }
 * 地图模板期望: { scenic_name, pois[], segments[], total_duration_min, total_walking_min }
 * v2 新增: _category, _cuisine_type, _avg_cost, _is_meal_stop, food_summary, narrations
 */
function transformForMap(routeResult, scenicName, intent) {
  const orderedPois = routeResult.ordered_pois || [];
  const segments = routeResult.segments || [];

  // 转换 POI 列表（v2：包含分类标记和美食属性）
  const mapPois = orderedPois.map((poi, idx) => {
    const lng = poi.location?.lng ?? poi.lng ?? poi.lon ?? 0;
    const lat = poi.location?.lat ?? poi.lat ?? 0;
    return {
      name: poi.name || `景点${idx + 1}`,
      lng,
      lat,
      index: idx + 1,
      duration_min: poi.suggested_duration_minutes || poi.suggested_duration || poi._duration || 30,
      tags: poi.tags || [],
      address: poi.address || '',
      description: poi.description || '',
      // 高德开放平台增强字段
      photos: poi.photos || [],
      business_hours: poi.business_hours || '',
      rating: poi.rating || null,
      _tel: poi._tel || null,
      // v2: 分类与美食属性
      _category: poi._category || 'scenic',
      _cuisine_type: poi._cuisine_type || '',
      _avg_cost: poi._avg_cost || null,
      _is_meal_stop: poi._is_meal_stop || false,
      _meal_time: poi._meal_time || '',
    };
  });

  // 转换路段数据（v2：标记美食路段）
  const mapSegments = segments.map((seg, idx) => ({
    from_index: idx,
    to_index: idx + 1,
    coords: seg.route_coords || [],
    walking_min: seg.walking_minutes || seg.walking_min || 0,
    from_name: seg.from || '',
    to_name: seg.to || '',
    _is_meal_segment: seg._is_meal_segment || false,
  }));

  // v2: 分离景点和美食统计
  const foodCount = mapPois.filter(p => p._category === 'food' || p._category === 'drink').length;
  const scenicCount = mapPois.length - foodCount;

  return {
    scenic_name: scenicName || intent?.scenic_area || '景区',
    pois: mapPois,
    segments: mapSegments,
    total_duration_min: routeResult.total_duration_minutes || routeResult.total_duration_min || 0,
    total_walking_min: routeResult.total_walking_minutes || routeResult.total_walking_min || 0,
    // v2: 统计信息
    food_count: foodCount,
    scenic_count: scenicCount,
  };
}

// ---------- v2: LLM 城市美食摘要 & 过渡语音文案 ----------

/**
 * 使用 LLM 为城市生成一段简短的美食文化摘要
 * 动态生成，覆盖全国任意城市，无需预置知识库
 *
 * @param {string} city - 城市名称
 * @param {object[]} foodPois - 收集到的美食 POI 列表
 * @param {object} config - LLM 配置
 * @returns {Promise<string>} 2-3 句话的美食摘要
 */
async function generateCityFoodSummary(city, foodPois, config) {
  if (!city || !foodPois || foodPois.length === 0) return '';

  const apiKey = config.llmApiKey || config.llm_api_key || config.apiKey || '';
  const endpoint = config.llmEndpoint || config.llm_endpoint || config.endpoint || 'https://api.deepseek.com/v1/chat/completions';
  const model = config.llmModel || config.llm_model || config.model || 'deepseek-chat';

  if (!apiKey) return '';

  // 提取美食 POI 的名称和菜系供 LLM 参考
  const foodInfo = foodPois.slice(0, 15).map(p =>
    `${p.name}${p._cuisine_type ? '(' + p._cuisine_type + ')' : ''}`
  ).join('、');

  try {
    const axios = require('axios');
    const resp = await axios.post(endpoint, {
      model,
      messages: [
        {
          role: 'system',
          content: `你是一个旅游美食专家。请根据以下城市和高德地图搜索到的餐厅数据，生成一段2-3句话的城市美食简介。内容应包含：该城市的饮食文化特色、推荐品尝的美食、推荐的美食区域或街道。语气亲切自然，像本地朋友在推荐。不要输出JSON，只输出纯文字。`,
        },
        {
          role: 'user',
          content: `城市：${city}\n搜索到的餐厅：${foodInfo}`,
        },
      ],
      temperature: 0.5,
      max_tokens: 256,
    }, {
      timeout: 10000,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });

    const text = resp.data?.choices?.[0]?.message?.content?.trim() || '';
    if (text.length > 10) {
      console.log(`   ✔ 城市美食摘要已生成 (${text.length} 字)`);
      return text;
    }
  } catch (err) {
    console.warn(`   ⚠ 美食摘要生成失败: ${err.message}`);
  }
  return '';
}

/**
 * 使用 LLM 为路线中每两个相邻景点之间生成过渡语音文案
 * 包含景点间步行信息和下一站的美食推荐
 *
 * @param {object[]} orderedPois - 排序后的 POI 列表
 * @param {object[]} segments - 路段列表
 * @param {string} city - 城市名称
 * @param {object} config - LLM 配置
 * @returns {Promise<object[]>} 过渡文案数组 [{ from, to, text }]
 */
async function generateTransitionNarrations(orderedPois, segments, city, config) {
  if (!orderedPois || orderedPois.length < 2) return [];

  const apiKey = config.llmApiKey || config.llm_api_key || config.apiKey || '';
  const endpoint = config.llmEndpoint || config.llm_endpoint || config.endpoint || 'https://api.deepseek.com/v1/chat/completions';
  const model = config.llmModel || config.llm_model || config.model || 'deepseek-chat';

  if (!apiKey) return [];

  const narrations = [];

  // 为每对相邻 POI 生成一段过渡文案
  for (let i = 0; i < orderedPois.length - 1; i++) {
    const from = orderedPois[i];
    const to = orderedPois[i + 1];
    const seg = segments[i] || {};
    const walkMin = seg.walking_minutes || 10;

    const toCategory = to._category || 'scenic';
    const isFoodNext = toCategory === 'food' || toCategory === 'drink';

    const prompt = isFoodNext
      ? `从"${from.name}"步行约${walkMin}分钟到"${to.name}"（${to._cuisine_type || '餐厅'}，人均${to._avg_cost || '未知'}元）。请用轻松活泼的语气写一段50字以内的过渡导览，突出美食期待感。只输出导览文字，不要其他内容。`
      : `从"${from.name}"步行约${walkMin}分钟到"${to.name}"。请用简洁自然的语气写一段40字以内的过渡导览。只输出导览文字，不要其他内容。`;

    try {
      const axios = require('axios');
      const resp = await axios.post(endpoint, {
        model,
        messages: [
          { role: 'system', content: '你是一个亲切的旅游语音导览员，为游客提供简短的步行路线解说。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.6,
        max_tokens: 128,
      }, {
        timeout: 8000,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      });

      const text = resp.data?.choices?.[0]?.message?.content?.trim() || '';
      if (text.length > 5) {
        narrations.push({ from: from.name, to: to.name, text });
      }
    } catch (err) {
      // 单段失败不影响其他段
      console.warn(`   ⚠ 过渡文案生成失败 (${from.name}→${to.name}): ${err.message}`);
    }
  }

  console.log(`   ✔ 生成 ${narrations.length} 段过渡语音文案`);
  return narrations;
}

/**
 * 使用 LLM 生成城市欢迎词
 *
 * @param {string} city - 城市名称
 * @param {string} scenicName - 景区名称
 * @param {number} poiCount - 景点数量
 * @param {number} foodCount - 美食数量
 * @param {object} config - LLM 配置
 * @returns {Promise<string>} 欢迎词文本
 */
async function generateCityWelcome(city, scenicName, poiCount, foodCount, config) {
  const apiKey = config.llmApiKey || config.llm_api_key || config.apiKey || '';
  const endpoint = config.llmEndpoint || config.llm_endpoint || config.endpoint || 'https://api.deepseek.com/v1/chat/completions';
  const model = config.llmModel || config.llm_model || config.model || 'deepseek-chat';

  if (!apiKey) return '';

  try {
    const axios = require('axios');
    const resp = await axios.post(endpoint, {
      model,
      messages: [
        {
          role: 'system',
          content: '你是一个热情亲切的旅游导览员。请为用户生成一段城市欢迎词，介绍即将开始的行程亮点。语气亲切自然，150字以内。只输出欢迎词文字，不要其他内容。',
        },
        {
          role: 'user',
          content: `城市：${city}，景区：${scenicName}，行程包含${poiCount}个景点和${foodCount}家推荐餐厅。`,
        },
      ],
      temperature: 0.6,
      max_tokens: 256,
    }, {
      timeout: 10000,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });

    const text = resp.data?.choices?.[0]?.message?.content?.trim() || '';
    if (text.length > 20) {
      console.log(`   ✔ 城市欢迎词已生成 (${text.length} 字)`);
      return text;
    }
  } catch (err) {
    console.warn(`   ⚠ 欢迎词生成失败: ${err.message}`);
  }
  return '';
}

// ---------- 多城市多日管线 ----------

/**
 * 跨城交通时间估算（简单规则：相邻城市高铁约60-120分钟）
 */
function estimateInterCityTravel(fromCity, toCity) {
  // 常见城市群高铁时间（分钟），粗略估算
  const knownRoutes = {
    '杭州-上海': 60, '上海-杭州': 60,
    '杭州-南京': 90, '南京-杭州': 90,
    '上海-南京': 75, '南京-上海': 75,
    '北京-天津': 30, '天津-北京': 30,
    '广州-深圳': 30, '深圳-广州': 30,
    '成都-重庆': 75, '重庆-成都': 75,
    '西安-成都': 210, '成都-西安': 210,
    '武汉-长沙': 90, '长沙-武汉': 90,
    '北京-上海': 270, '上海-北京': 270,
    '北京-杭州': 300, '杭州-北京': 300,
  };
  const key = `${fromCity}-${toCity}`;
  return knownRoutes[key] || 90; // 默认 90 分钟
}

/**
 * 执行多城市多日旅游规划管线。
 * 按天循环调用 POI 搜索 + 路线优化，生成跨城交通段，汇总全程数据。
 */
async function runMultiDayPipeline(userInput, intent, config, options) {
  const outputPath = options.output || 'tour-map.html';
  const days = intent.days;

  console.log(`\n🗺️ 多城市行程: ${days.length}天, ${days.map(d => d.city).join(' → ')}`);

  const dayResults = [];
  const interCitySegments = [];

  for (let i = 0; i < days.length; i++) {
    const dayPlan = days[i];
    console.log(`\n📍 Day ${i + 1}/${days.length}: ${dayPlan.city} · ${dayPlan.scenic_area || '市区'}`);

    // 阶段 2：获取 POI（每天独立调用）
    const scenicName = dayPlan.scenic_area || dayPlan.city;
    let pois;
    try {
      pois = await fetchScenicPOIs(scenicName, dayPlan.city, {
        ...config,
        intent: {
          ...intent,
          duration_hours: 8,  // 每天默认 8 小时
          scenic_area: dayPlan.scenic_area,
          city: dayPlan.city,
          food_preferences: dayPlan.food_preferences || intent.food_preferences,
        },
        skipAroundSearch: false,
        skipDetailFetch: false,
        includeFood: true,
        includeParking: false,
      });
      console.log(`   ✔ 获取到 ${pois.length} 个 POI`);
    } catch (err) {
      console.warn(`   ⚠ Day ${i + 1} POI 获取失败: ${err.message}`);
      pois = [];
    }

    if (!pois || pois.length === 0) {
      console.warn(`   ⚠ Day ${i + 1} 无 POI 数据，跳过`);
      continue;
    }

    // 阶段 3：路线优化（每天独立调用，8小时预算）
    let routeResult;
    const dayIntent = {
      ...intent,
      duration_hours: 8,
      scenic_area: dayPlan.scenic_area,
      city: dayPlan.city,
      food_preferences: dayPlan.food_preferences || intent.food_preferences,
    };
    try {
      routeResult = await optimizeRoute(pois, dayIntent, config);
      const selectedCount = (routeResult.ordered_pois || []).length;
      console.log(`   ✔ 路线优化完成, ${selectedCount} 个景点`);
    } catch (err) {
      console.warn(`   ⚠ Day ${i + 1} 路线优化失败: ${err.message}`);
      continue;
    }

    // 数据转换
    const mapData = transformForMap(routeResult, scenicName, dayIntent);

    // 智能内容生成（每天的美食摘要和欢迎词）
    const foodPois = pois.filter(p => p._category === 'food' || p._category === 'drink');
    let foodSummary = '';
    let welcome = '';
    try {
      [foodSummary, welcome] = await Promise.all([
        generateCityFoodSummary(dayPlan.city, foodPois, config),
        generateCityWelcome(dayPlan.city, scenicName, mapData.scenic_count, mapData.food_count, config),
      ]);
    } catch (err) {
      console.warn(`   ⚠ Day ${i + 1} 内容生成失败: ${err.message}`);
    }

    mapData.food_summary = foodSummary;
    mapData.city_welcome = welcome;
    mapData.city = dayPlan.city;

    // v2.2 美食数据深度增强
    try {
      const foodProvider = createFoodProvider(config);
      // 从 mapData.pois 中提取实际路线中的美食 POI
      const routeFoodPois = mapData.pois.filter(p => p._category === 'food' || p._category === 'drink');
      if (routeFoodPois.length > 0) {
        await foodProvider.enrichFoodPois(dayPlan.city, routeFoodPois, config);
        // enrichFoodPois 直接修改了 routeFoodPois 中的对象（与 mapData.pois 同引用）
      }
      const mustEat = await foodProvider.getCityMustEatList(dayPlan.city, config);
      if (mustEat) mapData.must_eat = mustEat;
    } catch (err) {
      console.warn(`   ⚠ Day ${i + 1} 美食增强失败（不影响主流程）: ${err.message}`);
    }

    dayResults.push({
      day: i + 1,
      city: dayPlan.city,
      scenic_name: scenicName,
      mapData,
    });

    // 跨城交通段（在相邻两天之间）
    if (i < days.length - 1) {
      const nextDay = days[i + 1];
      const travelMin = estimateInterCityTravel(dayPlan.city, nextDay.city);
      interCitySegments.push({
        type: 'inter_city',
        from_city: dayPlan.city,
        to_city: nextDay.city,
        from_day: i + 1,
        to_day: i + 2,
        transport: travelMin <= 60 ? 'train' : 'train',
        estimated_min: travelMin,
      });
    }
  }

  if (dayResults.length === 0) {
    throw new Error('多城市规划失败：所有天的 POI 数据获取均失败，请检查输入或网络连接。');
  }

  // 汇总全程统计
  let totalPois = 0;
  let totalDurationMin = 0;
  let totalWalkingMin = 0;
  let totalScenicCount = 0;
  let totalFoodCount = 0;
  let totalInterCityMin = 0;

  dayResults.forEach(d => {
    totalPois += (d.mapData.pois || []).length;
    totalDurationMin += d.mapData.total_duration_min || 0;
    totalWalkingMin += d.mapData.total_walking_min || 0;
    totalScenicCount += d.mapData.scenic_count || 0;
    totalFoodCount += d.mapData.food_count || 0;
  });

  interCitySegments.forEach(s => {
    totalInterCityMin += s.estimated_min || 0;
  });

  const totalDays = dayResults.length;
  const totalDurationStr = totalDays > 1 ? `${totalDays}天` : formatDuration(totalDurationMin);

  // 汇总 narrations（合并各天的过渡文案）
  const allNarrations = [];
  dayResults.forEach(d => {
    if (d.mapData.narrations) {
      allNarrations.push(...d.mapData.narrations);
    }
  });

  const summary = {
    is_multi_city: true,
    total_days: totalDays,
    days: dayResults,
    inter_city_segments: interCitySegments,
    scenic_name: dayResults.map(d => d.scenic_name).join('·'),
    city: dayResults.map(d => d.city).join('→'),
    poi_count: totalPois,
    total_duration: totalDurationStr,
    total_duration_min: totalDurationMin,
    total_walking_min: totalWalkingMin,
    total_inter_city_min: totalInterCityMin,
    scenic_count: totalScenicCount,
    food_count: totalFoodCount,
    narrations: allNarrations,
    intent: intent,
    output_file: path.resolve(outputPath),
  };

  console.log('\n✅ 多城市规划完成！');
  console.log('───────────────────────────────────');
  console.log(`  行程: ${dayResults.map(d => d.city).join(' → ')}`);
  console.log(`  天数: ${totalDays}天`);
  console.log(`  总景点: ${totalScenicCount} 个 | 总美食: ${totalFoodCount} 家`);
  console.log(`  总游览: ${formatDuration(totalDurationMin)}`);
  console.log(`  总步行: ${formatDuration(totalWalkingMin)}`);
  console.log(`  城际交通: ${formatDuration(totalInterCityMin)}`);
  console.log('───────────────────────────────────\n');

  return summary;
}

// ---------- 核心管线 ----------

/**
 * 执行完整的旅游规划管线。
 *
 * @param {string} userInput  用户自然语言输入
 * @param {object} [options]  可选配置
 * @param {string} [options.city]    城市名称（可选）
 * @param {string} [options.output]  输出 HTML 路径（默认 tour-map.html）
 * @param {boolean} [options.open]   是否自动在浏览器中打开
 * @returns {Promise<object>} 包含各阶段结果的汇总对象
 */
async function runPipeline(userInput, options = {}) {
  if (!userInput || typeof userInput !== 'string') {
    throw new Error('缺少用户输入，请使用 --input 参数提供自然语言描述。');
  }

  const config     = loadSharedConfig();
  const outputPath = options.output || 'tour-map.html';

  // ============================================================
  // 阶段 1：意图解析
  // ============================================================
  console.log('\n🔍 阶段一：意图解析...');
  let intent;
  try {
    intent = await parseIntent(userInput, config);
    console.log('   ✔ 意图解析完成');
    console.log(`     时长: ${intent.duration_hours || '?'}小时 | 节奏: ${intent.pace || '?'} | 兴趣: ${(intent.interests || []).join(', ') || '无'}`);
  } catch (err) {
    console.error('   ✘ 意图解析失败:', err.message);
    throw new Error(`阶段一（意图解析）出错: ${err.message}`);
  }

  // ============================================================
  // 多城市分支：走独立的多日管线
  // ============================================================
  if (intent.is_multi_city && intent.days && intent.days.length > 1) {
    return runMultiDayPipeline(userInput, intent, config, options);
  }

  // ============================================================
  // 阶段 2：景区数据抓取
  // ============================================================
  console.log('\n📍 阶段二：获取景区数据...');
  const scenicName = extractScenicName(intent);
  const city       = options.city || intent.city || '';

  if (!scenicName) {
    throw new Error('阶段二（景区数据抓取）出错：无法从意图中推断景区名称，请使用更具体的描述或通过 --city 指定。');
  }
  console.log(`   景区: ${scenicName}${city ? ' | 城市: ' + city : ''}`);

  let pois;
  try {
    // 高德开放平台多策略搜索：关键词搜索 + 周边搜索 + POI 详情增强
    pois = await fetchScenicPOIs(scenicName, city, {
      ...config,
      intent,
      skipAroundSearch: false,   // 启用周边搜索（发现附近景点）
      skipDetailFetch: false,     // 始终获取POI详情（图片/评分/营业时间）
      includeFood: true,          // 搜索附近餐饮
      includeParking: false,      // 步行游览不需要停车场
    });
    console.log(`   ✔ 获取到 ${pois.length} 个 POI 数据点`);
  } catch (err) {
    console.error('   ✘ 获取景区数据失败:', err.message);
    throw new Error(`阶段二（景区数据抓取）出错: ${err.message}`);
  }

  if (!pois || pois.length === 0) {
    throw new Error('阶段二（景区数据抓取）出错：未获取到任何 POI 数据，请检查景区名称或网络连接。');
  }

  // ============================================================
  // 阶段 3：路线优化
  // ============================================================
  console.log('\n🗺️ 阶段三：路线优化...');
  let routeResult;
  try {
    routeResult = await optimizeRoute(pois, intent, config);
    const selectedCount = (routeResult.ordered_pois || routeResult.selected_pois || routeResult.pois || []).length;
    const walkMin       = routeResult.total_walking_minutes || routeResult.walking_time || 0;
    console.log(`   ✔ 路线优化完成`);
    console.log(`     选中景点: ${selectedCount} 个 | 步行时间: ${formatDuration(walkMin)}`);
  } catch (err) {
    console.error('   ✘ 路线优化失败:', err.message);
    throw new Error(`阶段三（路线优化）出错: ${err.message}`);
  }

  // ============================================================
  // 数据转换：路线优化结果 → 地图模板格式
  // ============================================================
  const mapData = transformForMap(routeResult, scenicName, intent);

  // ============================================================
  // v2 阶段：智能内容生成（美食摘要 + 过渡语音文案 + 欢迎词）
  // ============================================================
  console.log('\n✨ v2 增强：智能内容生成...');
  const orderedPois = routeResult.ordered_pois || [];
  const routeSegments = routeResult.segments || [];
  const foodPois = pois.filter(p => p._category === 'food' || p._category === 'drink');

  // 并行生成三种内容
  const [foodSummary, narrations, welcome] = await Promise.all([
    generateCityFoodSummary(city, foodPois, config),
    generateTransitionNarrations(orderedPois, routeSegments, city, config),
    generateCityWelcome(city, scenicName, mapData.scenic_count, mapData.food_count, config),
  ]);

  // 注入到地图数据
  mapData.food_summary = foodSummary;
  mapData.narrations = narrations;
  mapData.city_welcome = welcome;
  mapData.city = city;

  if (foodSummary) console.log(`   ✔ 美食摘要: ${foodSummary.slice(0, 40)}...`);
  if (welcome) console.log(`   ✔ 欢迎词: ${welcome.slice(0, 40)}...`);
  if (narrations.length > 0) console.log(`   ✔ 过渡文案: ${narrations.length} 段`);

  // ============================================================
  // v2.2 增强：美食 POI 深度信息 + 城市必吃清单
  // ============================================================
  console.log('\n🍜 v2.2 增强：美食数据深度增强...');
  try {
    const foodProvider = createFoodProvider(config);
    // 从 mapData.pois 中提取实际路线中的美食 POI（而非全部候选）
    const routeFoodPois = mapData.pois.filter(p => p._category === 'food' || p._category === 'drink');
    if (routeFoodPois.length > 0) {
      await foodProvider.enrichFoodPois(city, routeFoodPois, config);
      // enrichFoodPois 直接修改了 routeFoodPois 中的对象（与 mapData.pois 同引用）
    }
  } catch (err) {
    console.warn(`   ⚠ 美食增强失败（不影响主流程）: ${err.message}`);
  }
  try {
    const foodProvider = createFoodProvider(config);
    const mustEat = await foodProvider.getCityMustEatList(city, config);
    if (mustEat) mapData.must_eat = mustEat;
  } catch (err) {
    console.warn(`   ⚠ 必吃清单生成失败（不影响主流程）: ${err.message}`);
  }

  // ============================================================
  // 阶段 4：生成地图（可选跳过 — Web 模式下前端动态渲染）
  // ============================================================
  console.log('\n🎨 阶段四：生成地图...');
  if (!options.skipMap) {
    try {
      await generateMap(mapData, outputPath, config);
      console.log('   ✔ 地图生成完成');
    } catch (err) {
      console.error('   ✘ 地图生成失败:', err.message);
      throw new Error(`阶段四（地图可视化）出错: ${err.message}`);
    }
  } else {
    console.log('   ⊘ 跳过 HTML 文件生成（前端动态渲染模式）');
  }

  // ============================================================
  // 汇总 & 输出
  // ============================================================
  const selectedPois = routeResult.ordered_pois || routeResult.selected_pois || routeResult.pois || [];
  const totalDuration = routeResult.total_duration_minutes
    || routeResult.total_minutes
    || (intent.duration_hours ? intent.duration_hours * 60 : 0);
  const walkingTime = routeResult.total_walking_minutes || routeResult.walking_time || 0;

  const summary = {
    scenic_name:   scenicName,
    city:          city,
    poi_count:     selectedPois.length,
    total_duration: formatDuration(totalDuration),
    walking_time:  formatDuration(walkingTime),
    output_file:   path.resolve(outputPath),
    intent:        intent,
    route_result:  routeResult,
    mapData:       mapData,
    // v2: 智能内容
    food_summary:  foodSummary,
    narrations:    narrations,
    city_welcome:  welcome,
    food_count:    mapData.food_count,
    scenic_count:  mapData.scenic_count,
  };

  console.log('\n✅ 规划完成！地图已保存至: ' + summary.output_file);
  console.log('───────────────────────────────────');
  console.log(`  景区名称: ${summary.scenic_name}`);
  console.log(`  景点数量: ${summary.scenic_count} 个 | 美食推荐: ${summary.food_count} 家`);
  console.log(`  游览时长: ${summary.total_duration}`);
  console.log(`  步行时间: ${summary.walking_time}`);
  console.log(`  输出文件: ${summary.output_file}`);
  console.log('───────────────────────────────────\n');

  // 如果用户指定了 --open，尝试在浏览器中打开
  if (options.open) {
    const { exec } = require('child_process');
    const absPath  = path.resolve(outputPath);
    const cmd = process.platform === 'darwin'
      ? `open "${absPath}"`
      : process.platform === 'win32'
        ? `start "" "${absPath}"`
        : `xdg-open "${absPath}"`;
    exec(cmd, (err) => {
      if (err) console.warn('⚠️  无法自动打开浏览器:', err.message);
    });
  }

  return summary;
}

// ---------- CLI 入口 ----------

async function main() {
  const args = process.argv.slice(2);

  // 简易参数解析（支持 --key=value 和 --key value 两种格式）
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        parsed[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        parsed[arg.slice(2)] = args[++i];
      } else {
        // 无值的 flag，如 --open
        parsed[arg.slice(2)] = true;
      }
    }
  }

  if (parsed.help || parsed.h) {
    console.log(`
次元旅人 - 智能旅游规划管线

用法:
  node pipeline.js --input="我想悠闲地逛西湖2小时，主要想看古建筑和自然风光"

参数:
  --input   用户自然语言输入（必填）
  --city    城市名称（可选，可从意图中推断）
  --output  输出 HTML 文件路径（默认: tour-map.html）
  --open    完成后自动在浏览器中打开
  --help    显示此帮助信息
`);
    process.exit(0);
  }

  if (!parsed.input) {
    console.error('错误：缺少 --input 参数。');
    console.error('用法：node pipeline.js --input="你的旅游需求"');
    process.exit(1);
  }

  const options = {
    city:   parsed.city   || undefined,
    output: parsed.output || 'tour-map.html',
    open:   !!parsed.open,
  };

  try {
    await runPipeline(parsed.input, options);
  } catch (err) {
    console.error('\n❌ 管线执行失败:', err.message);
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

// 当作为脚本直接运行时执行 CLI
if (require.main === module) {
  main();
}

module.exports = { runPipeline, generateCityFoodSummary, generateTransitionNarrations, generateCityWelcome };
