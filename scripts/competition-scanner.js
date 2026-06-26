/**
 * 餐饮选址通 - 多半径竞争扫描模块
 *
 * 功能：
 *   以目标坐标为中心，执行四层同心圆 POI 扫描（150m / 500m / 1km / 3km），
 *   统计每层的餐饮数量、菜系分布、平均评分和人均消费。
 *
 * 复用：
 *   - scenic-data-fetcher.js 的 fetchAround()、extractCuisineType()、extractAvgCost()
 *
 * CLI 用法：
 *   node competition-scanner.js --lng=104.08 --lat=30.65 --city=成都
 *
 * 导出：
 *   scanCompetition(lng, lat, apiKey, options)
 *   classifyByCuisine(pois)
 *   computeAvgRating(pois)
 *   computeAvgCost(pois)
 */

'use strict';

const path = require('path');

// 复用 scenic-data-fetcher 的搜索和工具函数
const {
  fetchAround,
  extractCuisineType,
  extractAvgCost,
  resolveApiKey,
} = require('./scenic-data-fetcher');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 高德 POI 餐饮服务大类（typecode 前缀 05） */
const FOOD_TYPES = '餐饮服务|中餐厅|小吃快餐|特色菜|地方风味|外国餐厅|休闲餐饮|火锅店';

/** 饮品/甜品类 */
const DRINK_TYPES = '咖啡厅|茶艺馆|甜品店|冷饮店|糕饼店';

/** 四层同心圆扫描半径（米） */
const SCAN_RINGS = [
  { radius: 150,  label: 'core',   purpose: '直接竞争密度' },
  { radius: 500,  label: 'inner',  purpose: '竞争分类（菜系细分）' },
  { radius: 1000, label: 'middle', purpose: '市场分析（互补业态）' },
  { radius: 3000, label: 'outer',  purpose: '宏观商圈画像' },
];

/** 请求间延迟（毫秒），避免高德 QPS 限流 */
const REQUEST_DELAY = 300;

/** 每层每类 POI 的最大分页数（每页25条） */
const RING_MAX_PAGES = {
  core: 2,    // 150m 半径：最多 50 条
  inner: 3,   // 500m 半径：最多 75 条
  middle: 3,  // 1000m 半径：最多 75 条
  outer: 3,   // 3000m 半径：最多 75 条
};

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 延迟指定毫秒数 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 按菜系类型对 POI 列表分组统计
 * @param {Array} pois - 增强后的 POI 数组（含 _cuisine 字段）
 * @returns {Object} { "川菜": 12, "湘菜": 8, "火锅": 5, ... }
 */
function classifyByCuisine(pois) {
  const breakdown = {};
  for (const poi of pois) {
    const cuisine = poi._cuisine || poi.cuisine || extractCuisineType(poi) || '其他';
    breakdown[cuisine] = (breakdown[cuisine] || 0) + 1;
  }
  // 按数量降序排列
  const sorted = Object.entries(breakdown)
    .sort((a, b) => b[1] - a[1])
    .reduce((obj, [k, v]) => { obj[k] = v; return obj; }, {});
  return sorted;
}

/**
 * 计算 POI 列表的平均评分
 * @param {Array} pois - 增强后的 POI 数组（含 _rating 或 rating 字段）
 * @returns {number} 平均评分（0-5），无评分数据时返回 0
 */
function computeAvgRating(pois) {
  const rated = pois.filter(p => (p._rating || p.rating) > 0);
  if (rated.length === 0) return 0;
  const sum = rated.reduce((acc, p) => acc + (p._rating || p.rating || 0), 0);
  return Math.round((sum / rated.length) * 10) / 10;
}

/**
 * 计算 POI 列表的平均人均消费
 * @param {Array} pois - 增强后的 POI 数组（含 _avg_cost 或 avg_cost 字段）
 * @returns {number} 平均人均消费（元），无数据时返回 0
 */
function computeAvgCost(pois) {
  const withCost = pois.filter(p => (p._avg_cost || p.avg_cost) > 0);
  if (withCost.length === 0) return 0;
  const sum = withCost.reduce((acc, p) => acc + (p._avg_cost || p.avg_cost || 0), 0);
  return Math.round(sum / withCost.length);
}

// ---------------------------------------------------------------------------
// 核心扫描函数
// ---------------------------------------------------------------------------

/**
 * 执行多半径竞争扫描
 *
 * 对每一层半径，分别扫描餐饮和饮品两大类 POI，统计数量和菜系分布。
 *
 * @param {number} lng - 中心点经度
 * @param {number} lat - 中心点纬度
 * @param {string} apiKey - 高德 Web Service API Key
 * @param {Object} [options] - 配置选项
 * @param {string} [options.city] - 城市名称（用于日志）
 * @param {string} [options.areaName] - 商圈名称（用于日志）
 * @param {number} [options.maxRadius] - 最大扫描半径（默认 3000m）
 * @param {number} [options.pageSize] - 每层每类 POI 最大返回数量（默认 25）
 * @returns {Promise<Object>} 扫描结果
 *   {
 *     center: { lng, lat },
 *     rings: {
 *       core:   { food_count, drink_count, total_count, cuisine_breakdown, avg_rating, avg_cost, pois },
 *       inner:  { ... },
 *       middle: { ... },
 *       outer:  { ... }
 *     },
 *     summary: { total_food, total_drink, top_cuisines }
 *   }
 */
async function scanCompetition(lng, lat, apiKey, options = {}) {
  const city = options.city || '';
  const areaName = options.areaName || '';
  const pageSize = options.pageSize || 25;
  const maxRadius = options.maxRadius || 3000;

  console.log(`\n[竞争扫描] 开始扫描 ${city} ${areaName} (${lng.toFixed(4)}, ${lat.toFixed(4)})`);
  console.log(`[竞争扫描] 扫描半径: ${SCAN_RINGS.map(r => r.radius + 'm').join(' / ')}`);

  const results = {
    center: { lng, lat },
    rings: {},
    summary: {},
  };

  // 逐层扫描（串行，避免 QPS 限流）
  for (let ringIdx = 0; ringIdx < SCAN_RINGS.length; ringIdx++) {
    const ring = SCAN_RINGS[ringIdx];
    if (ring.radius > maxRadius) {
      console.log(`[竞争扫描] 跳过 ${ring.label} (${ring.radius}m) — 超出最大半径 ${maxRadius}m`);
      continue;
    }

    console.log(`\n[竞争扫描] ── ${ring.label} (${ring.radius}m) ── ${ring.purpose}`);

    const ringMaxPages = RING_MAX_PAGES[ring.label] || 2;

    // 先扫描餐饮
    const foodPois = await fetchAround(lng, lat, apiKey, {
      types: FOOD_TYPES,
      radius: ring.radius,
      pageSize: pageSize,
      maxPages: ringMaxPages,
      sortrule: 'weight',  // 按商业权重排序，重要的排前面
      searchLabel: `竞争-餐饮-${ring.label}`,
      ...options,
    });

    // 请求间延迟，避免 QPS 限流
    await sleep(REQUEST_DELAY);

    // 再扫描饮品
    const drinkPois = await fetchAround(lng, lat, apiKey, {
      types: DRINK_TYPES,
      radius: ring.radius,
      pageSize: Math.min(pageSize, 15),  // 饮品类少取一些
      maxPages: ringMaxPages,
      sortrule: 'weight',
      searchLabel: `竞争-饮品-${ring.label}`,
      ...options,
    });

    const allPois = [...foodPois, ...drinkPois];

    results.rings[ring.label] = {
      radius: ring.radius,
      purpose: ring.purpose,
      food_count: foodPois.length,
      drink_count: drinkPois.length,
      total_count: allPois.length,
      cuisine_breakdown: classifyByCuisine(foodPois),
      avg_rating: computeAvgRating(allPois),
      avg_cost: computeAvgCost(allPois),
      pois: allPois,
    };

    console.log(`[竞争扫描] ${ring.label}: 餐饮 ${foodPois.length} 家 | 饮品 ${drinkPois.length} 家 | 共 ${allPois.length} 家`);
    if (Object.keys(results.rings[ring.label].cuisine_breakdown).length > 0) {
      const top3 = Object.entries(results.rings[ring.label].cuisine_breakdown).slice(0, 3);
      console.log(`[竞争扫描] 菜系 Top3: ${top3.map(([k, v]) => `${k}(${v})`).join(', ')}`);
    }

    // 层间延迟（非最后一层时）
    if (ringIdx < SCAN_RINGS.length - 1) {
      await sleep(REQUEST_DELAY);
    }
  }

  // 汇总信息
  const innerRing = results.rings.inner || results.rings.core;
  if (innerRing) {
    results.summary = {
      total_food: innerRing.food_count,
      total_drink: innerRing.drink_count,
      top_cuisines: Object.entries(innerRing.cuisine_breakdown).slice(0, 5).map(([name, count]) => ({
        name,
        count,
        ratio: innerRing.food_count > 0 ? Math.round(count / innerRing.food_count * 100) : 0,
      })),
    };
  }

  console.log(`\n[竞争扫描] 扫描完成 ✓`);
  return results;
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
    console.error('用法: node competition-scanner.js --lng=104.08 --lat=30.65 --city=成都');
    process.exit(1);
  }

  const apiKey = resolveApiKey({});
  if (!apiKey) {
    console.error('错误: 未找到高德 API Key，请在 config.json 中配置 amapWebServiceKey');
    process.exit(1);
  }

  scanCompetition(lng, lat, apiKey, { city, areaName: city })
    .then(result => {
      console.log('\n═══════════════════════════════════');
      console.log('扫描结果汇总:');
      console.log('═══════════════════════════════════');
      for (const [label, ring] of Object.entries(result.rings)) {
        console.log(`\n${label} (${ring.radius}m) - ${ring.purpose}:`);
        console.log(`  餐饮: ${ring.food_count} 家 | 饮品: ${ring.drink_count} 家`);
        console.log(`  平均评分: ${ring.avg_rating} | 人均消费: ${ring.avg_cost} 元`);
        if (Object.keys(ring.cuisine_breakdown).length > 0) {
          const top5 = Object.entries(ring.cuisine_breakdown).slice(0, 5);
          console.log(`  菜系分布: ${top5.map(([k, v]) => `${k}(${v})`).join(', ')}`);
        }
      }
      if (result.summary.top_cuisines && result.summary.top_cuisines.length > 0) {
        console.log(`\nTop 菜系 (500m):`);
        result.summary.top_cuisines.forEach(c => {
          console.log(`  ${c.name}: ${c.count} 家 (${c.ratio}%)`);
        });
      }
    })
    .catch(err => {
      console.error(`\n扫描失败: ${err.message}`);
      process.exit(1);
    });
}

// ---------------------------------------------------------------------------
// 模块导出
// ---------------------------------------------------------------------------

module.exports = {
  scanCompetition,
  classifyByCuisine,
  computeAvgRating,
  computeAvgCost,
  // 常量导出供其他选址模块使用
  FOOD_TYPES,
  DRINK_TYPES,
  SCAN_RINGS,
};
