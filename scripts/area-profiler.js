/**
 * 餐饮选址通 - 商圈画像生成器 (Area Profiler)
 *
 * 功能：
 *   围绕指定坐标，并行扫描商业、住宅、交通、互补业态四类 POI，
 *   计算商圈类型、交通便利度评分、互补业态评分，并调用 LLM 生成
 *   100 字以内的商圈画像摘要。
 *
 * 复用：
 *   - scenic-data-fetcher.js 的 fetchAround()、resolveApiKey()
 *   - site-intent-parser.js 的 LLM 配置加载模式
 *
 * CLI 用法：
 *   node area-profiler.js --lng=104.08 --lat=30.65 --city=成都
 *
 * 导出：
 *   profileArea(lng, lat, apiKey, options)   —— 主函数（异步）
 *   scoreTransit(transitPois)                —— 交通便利度评分 0-10
 *   scoreComplementary(compPois)             —— 互补业态评分 0-10
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// 复用 scenic-data-fetcher 的搜索和密钥解析函数
const {
  fetchAround,
  resolveApiKey,
} = require('./scenic-data-fetcher');

// ---------------------------------------------------------------------------
// axios 延迟加载
// ---------------------------------------------------------------------------

let _axios = null;
function getAxios() {
  if (!_axios) {
    try { _axios = require('axios'); }
    catch (_) { throw new Error('未安装 axios'); }
  }
  return _axios;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 延迟指定毫秒数，避免高德 QPS 限流 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const REQUEST_DELAY = 300;  // 请求间延迟（毫秒）

// ---------------------------------------------------------------------------
// POI 类型常量
// ---------------------------------------------------------------------------

const COMMERCIAL_TYPES = '商场|购物中心|写字楼|商务住宅';
const RESIDENTIAL_TYPES = '住宅小区|宿舍|公寓';
const TRANSIT_TYPES = '地铁站|公交站';
const COMPLEMENTARY_TYPES = '便利店|超市|电影院|茶艺馆|咖啡厅';

// ---------------------------------------------------------------------------
// LLM 配置加载（同 site-intent-parser.js 模式）
// ---------------------------------------------------------------------------

function loadLLMConfig() {
  let config = {};
  const configPaths = [
    path.resolve(__dirname, '..', 'config.json'),
    path.resolve(__dirname, 'config.json'),
  ];
  for (const p of configPaths) {
    try { config = JSON.parse(fs.readFileSync(p, 'utf-8')); break; } catch (_) {}
  }
  return {
    endpoint: process.env.LLM_ENDPOINT || config.llmEndpoint || config.endpoint || 'https://api.deepseek.com/v1/chat/completions',
    apiKey: process.env.LLM_API_KEY || config.llmApiKey || config.apiKey || '',
    model: process.env.LLM_MODEL || config.llmModel || config.model || 'deepseek-chat',
    timeout: config.timeout || 15000,
  };
}

// ---------------------------------------------------------------------------
// 评分函数
// ---------------------------------------------------------------------------

/**
 * 交通便利度评分（0-10）
 * 地铁站：每个 3 分，上限 6 分
 * 公交站：每个 0.5 分，上限 4 分
 *
 * @param {Array} transitPois - 交通 POI 列表
 * @returns {number} 0-10 分
 */
function scoreTransit(transitPois) {
  if (!Array.isArray(transitPois) || transitPois.length === 0) return 0;

  let subwayCount = 0;
  let busCount = 0;

  for (const poi of transitPois) {
    const name = (poi.name || '').toLowerCase();
    const type = (poi.type || poi.typecode || '').toString();
    if (type.includes('地铁站') || name.includes('地铁站') || name.includes('地铁')) {
      subwayCount++;
    } else {
      busCount++;
    }
  }

  const subwayScore = Math.min(subwayCount * 3, 6);
  const busScore = Math.min(busCount * 0.5, 4);

  return Math.min(Math.round((subwayScore + busScore) * 10) / 10, 10);
}

/**
 * 互补业态评分（0-10）
 * 便利店：每个 1.5 分
 * 超市：每个 2 分
 * 电影院：每个 2 分
 * 茶艺馆 / 咖啡厅：每个 1 分
 *
 * @param {Array} compPois - 互补业态 POI 列表
 * @returns {number} 0-10 分
 */
function scoreComplementary(compPois) {
  if (!Array.isArray(compPois) || compPois.length === 0) return 0;

  let score = 0;

  for (const poi of compPois) {
    const name = (poi.name || '').toLowerCase();
    const type = (poi.type || '').toString();

    if (type.includes('电影院') || name.includes('电影') || name.includes('影院')) {
      score += 2;
    } else if (type.includes('超市') || (name.includes('超市') && !name.includes('便利店'))) {
      score += 2;
    } else if (type.includes('便利店') || name.includes('便利')) {
      score += 1.5;
    } else if (type.includes('茶艺馆') || type.includes('咖啡厅') || name.includes('茶') || name.includes('咖啡')) {
      score += 1;
    } else {
      // 未明确分类的 POI 给一个基础分
      score += 0.5;
    }
  }

  return Math.min(Math.round(score * 10) / 10, 10);
}

// ---------------------------------------------------------------------------
// LLM 商圈画像叙事
// ---------------------------------------------------------------------------

const AREA_SYSTEM_PROMPT = '你是商业地产分析师。根据以下区域POI数据，生成100字以内商圈画像。包含：商圈类型、主要客群、消费水平、交通条件、适合的餐饮类型。只输出文本，不要JSON。';

/**
 * 根据画像数据生成 LLM 叙事摘要
 *
 * @param {Object} profile - 商圈画像数据
 * @param {Object} options - 可选配置（含 LLM 覆盖参数）
 * @returns {Promise<string>} 100 字以内的商圈画像文本
 */
async function generateAreaNarrative(profile, options = {}) {
  const llmConfig = loadLLMConfig();

  // 若未配置 apiKey，直接走模板回退
  if (!llmConfig.apiKey) {
    console.log('[商圈画像] 未配置 LLM API Key，使用模板叙事');
    return buildTemplateNarrative(profile);
  }

  const userPrompt = [
    `商圈类型: ${profile.areaType}`,
    `商业POI数: ${profile.commercialCount || 0}`,
    `住宅POI数: ${profile.residentialCount || 0}`,
    `交通便利度: ${profile.transitScore}/10`,
    `互补业态评分: ${profile.complementaryScore}/10`,
    `交通设施: ${(profile.transitDetails || []).map(t => t.name).join('、') || '无'}`,
    `互补业态: ${(profile.complementaryDetails || []).map(c => c.name).join('、') || '无'}`,
  ].join('\n');

  try {
    const response = await getAxios().post(llmConfig.endpoint, {
      model: llmConfig.model,
      messages: [
        { role: 'system', content: AREA_SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0.5,
      max_tokens: 300,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmConfig.apiKey}`,
      },
      timeout: 10000,
    });

    const text = response.data?.choices?.[0]?.message?.content?.trim();
    if (text) {
      return text.slice(0, 200);
    }
    console.log('[商圈画像] LLM 返回为空，使用模板叙事');
    return buildTemplateNarrative(profile);
  } catch (err) {
    console.log(`[商圈画像] LLM 叙事生成失败: ${err.message}，使用模板回退`);
    return buildTemplateNarrative(profile);
  }
}

/**
 * 模板回退叙事（当 LLM 不可用时）
 */
function buildTemplateNarrative(profile) {
  const typeLabel = {
    commercial: '商业核心区',
    residential: '居民生活区',
    mixed: '商住混合区',
  }[profile.areaType] || '综合区域';

  const transitLabel = profile.transitScore >= 7
    ? '交通极为便利'
    : profile.transitScore >= 4
      ? '交通较为便利'
      : '交通配套一般';

  const compLabel = profile.complementaryScore >= 7
    ? '周边配套设施完善，消费氛围浓厚'
    : profile.complementaryScore >= 4
      ? '周边有一定商业配套'
      : '周边配套尚待完善';

  const crowdLabel = profile.areaType === 'commercial'
    ? '以商务白领为主要客群'
    : profile.areaType === 'residential'
      ? '以周边居民为主要客群'
      : '客群来源多元';

  return `该区域属于${typeLabel}，${crowdLabel}。${transitLabel}，${compLabel}。适合开设与周边消费水平匹配的大众餐饮业态。`;
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

/**
 * 生成商圈画像
 *
 * @param {number} lng - 经度
 * @param {number} lat - 纬度
 * @param {string} apiKey - 高德 API Key（可选，会通过 resolveApiKey 回退查找）
 * @param {Object} options - 可选配置
 * @returns {Promise<Object>} 商圈画像结果
 */
async function profileArea(lng, lat, apiKey, options = {}) {
  const resolvedKey = apiKey || resolveApiKey(options);
  if (!resolvedKey) {
    throw new Error('[商圈画像] 未找到高德 API Key，请通过参数、环境变量或 config.json 配置');
  }

  console.log(`[商圈画像] 开始分析坐标: (${lng}, ${lat})`);

  // 串行发起四类 POI 扫描（避免 QPS 限流）
  const commercial = await fetchAround(lng, lat, resolvedKey, {
    types: COMMERCIAL_TYPES,
    radius: 1000,
    pageSize: 25,
    searchLabel: '商业POI',
  });

  await sleep(REQUEST_DELAY);

  const residential = await fetchAround(lng, lat, resolvedKey, {
    types: RESIDENTIAL_TYPES,
    radius: 1000,
    pageSize: 25,
    searchLabel: '住宅POI',
  });

  await sleep(REQUEST_DELAY);

  const transit = await fetchAround(lng, lat, resolvedKey, {
    types: TRANSIT_TYPES,
    radius: 500,
    pageSize: 25,
    searchLabel: '交通POI',
  });

  await sleep(REQUEST_DELAY);

  const complementary = await fetchAround(lng, lat, resolvedKey, {
    types: COMPLEMENTARY_TYPES,
    radius: 500,
    pageSize: 25,
    searchLabel: '互补业态',
  });

  console.log(`[商圈画像] 扫描完成: 商业=${commercial.length}, 住宅=${residential.length}, 交通=${transit.length}, 互补=${complementary.length}`);

  // 计算商圈类型
  const totalBase = commercial.length + residential.length + transit.length;
  const commercialRatio = commercial.length / Math.max(totalBase, 1);

  let areaType;
  if (commercialRatio > 0.6) {
    areaType = 'commercial';
  } else if (residential.length > commercial.length * 2) {
    areaType = 'residential';
  } else {
    areaType = 'mixed';
  }

  // 评分
  const transitScore = scoreTransit(transit);
  const complementaryScore = scoreComplementary(complementary);

  // 详情列表
  const transitDetails = transit.map(poi => ({
    name: poi.name || '未知',
    type: (poi.type || '').split(';')[0] || '未知',
  }));

  const complementaryDetails = complementary.map(poi => ({
    name: poi.name || '未知',
    category: (poi.type || '').split(';')[0] || '未知',
  }));

  // 构造基础画像
  const profile = {
    areaType,
    commercialRatio: Math.round(commercialRatio * 100) / 100,
    commercialCount: commercial.length,
    residentialCount: residential.length,
    transitCount: transit.length,
    complementaryCount: complementary.length,
    transitScore,
    complementaryScore,
    transitDetails,
    complementaryDetails,
  };

  // LLM 叙事生成
  profile.narrative = await generateAreaNarrative(profile, options);

  console.log(`[商圈画像] 分析完成 — 类型: ${areaType}, 交通: ${transitScore}/10, 互补: ${complementaryScore}/10`);

  return profile;
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

  const lng = parseFloat(args.lng);
  const lat = parseFloat(args.lat);
  const city = args.city || '';

  if (isNaN(lng) || isNaN(lat)) {
    console.error('[商圈画像] 用法: node area-profiler.js --lng=经度 --lat=纬度 --city=城市');
    process.exit(1);
  }

  console.log(`[商圈画像] 城市: ${city || '未指定'}, 坐标: (${lng}, ${lat})`);
  console.log('[商圈画像] -------------------------------------------');

  profileArea(lng, lat, null, { city })
    .then(result => {
      console.log('\n[商圈画像] ====== 分析结果 ======');
      console.log(`  商圈类型:     ${result.areaType}`);
      console.log(`  商业占比:     ${(result.commercialRatio * 100).toFixed(0)}%`);
      console.log(`  商业POI数:    ${result.commercialCount}`);
      console.log(`  住宅POI数:    ${result.residentialCount}`);
      console.log(`  交通POI数:    ${result.transitCount}`);
      console.log(`  互补业态数:   ${result.complementaryCount}`);
      console.log(`  交通便利度:   ${result.transitScore}/10`);
      console.log(`  互补业态评分: ${result.complementaryScore}/10`);

      if (result.transitDetails.length > 0) {
        console.log('\n[商圈画像] 交通设施:');
        result.transitDetails.forEach(t => {
          console.log(`  - ${t.name} (${t.type})`);
        });
      }

      if (result.complementaryDetails.length > 0) {
        console.log('\n[商圈画像] 互补业态:');
        result.complementaryDetails.forEach(c => {
          console.log(`  - ${c.name} (${c.category})`);
        });
      }

      console.log(`\n[商圈画像] 画像摘要:\n  ${result.narrative}`);
    })
    .catch(err => {
      console.error(`[商圈画像] 分析失败: ${err.message}`);
      process.exit(1);
    });
}

// ---------------------------------------------------------------------------
// 模块导出
// ---------------------------------------------------------------------------

module.exports = { profileArea, scoreTransit, scoreComplementary };
