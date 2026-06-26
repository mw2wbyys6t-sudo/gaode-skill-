'use strict';

/**
 * ============================================================================
 * site-analyzer.js  -  选址评分引擎 (Site Scoring Engine)
 * ============================================================================
 *
 * 模块归属：餐饮选址通 - 餐厅选址评估工具
 *
 * 功能说明：
 *   基于 5 大维度、总分 100 分的评分模型，对候选餐饮选址进行量化评估。
 *   同时提供多站点横向比较功能，输出排名与各维度优劣对比。
 *
 * 评分模型（5 维度 × 20 分 = 100 分）：
 *   1. 战略因素 (Strategic)    20 分 - 城市等级 + 商圈类型 + 发展趋势
 *   2. 竞争因素 (Competition)  20 分 - 核心圈密度 + 同品类占比（反直觉：竞争越多越好）
 *   3. 销售潜力 (Sales)        20 分 - 人流代理 + 截流率估算
 *   4. 服务配套 (Service)      20 分 - 互补商业 + 交通便利
 *   5. 立地条件 (Conditions)   20 分 - 区域类型 + 街道可达性 + 物业可行性
 *
 * 反直觉说明：
 *   竞争维度中，高密度竞争意味着该区域已被市场验证——有足够多的食客愿意在此消费。
 *   对于有差异化能力的餐饮品牌来说，进入成熟竞争区域反而风险更低。
 *   同品类占比低则意味着仍有差异化切入空间，因此给予额外加分。
 *
 * 依赖：
 *   - ./route-optimizer  (haversine 函数，用于未来距离计算扩展)
 *
 * 用法：
 *   const { scoreSite, compareSites, classifyCityTier } = require('./site-analyzer');
 *   const result = scoreSite(areaData, siteIntent);
 *   const comparison = compareSites([result1, result2, result3]);
 *
 * CLI 测试：
 *   node site-analyzer.js
 * ============================================================================
 */

const { haversine } = require('./route-optimizer');

// ============================================================================
// 城市等级分类常量
// ============================================================================

/** 一线城市 */
const TIER1 = ['北京', '上海', '广州', '深圳'];

/** 新一线城市 */
const NEW_TIER1 = [
  '成都', '杭州', '重庆', '武汉', '西安', '长沙',
  '南京', '苏州', '天津', '郑州', '东莞', '青岛',
  '昆明', '宁波', '合肥'
];

/** 二线城市关键词（用于模糊匹配） */
const TIER2_KEYWORDS = ['省会', '经济特区', '副省级'];

/**
 * 城市等级分类
 * @param {string} city - 城市名称
 * @returns {string} 等级标签: '一线' | '新一线' | '二线' | '三四线'
 */
function classifyCityTier(city) {
  if (!city || typeof city !== 'string') {
    return '三四线';
  }

  const trimmed = city.trim();

  if (TIER1.includes(trimmed)) {
    return '一线';
  }

  if (NEW_TIER1.includes(trimmed)) {
    return '新一线';
  }

  // 二线城市：省会城市、经济特区、副省级城市等
  // 由于缺少完整的二线城市列表，这里用常见省会城市做兜底匹配
  // 实际生产环境应接入完整的城市数据库
  const provincialCapitals = [
    '石家庄', '太原', '呼和浩特', '沈阳', '长春', '哈尔滨',
    '福州', '南昌', '济南', '海口', '贵阳', '兰州', '西宁',
    '银川', '乌鲁木齐', '拉萨', '南宁', '台北',
    '厦门', '珠海', '汕头', // 经济特区
    '大连', '烟台', '温州', '无锡', '常州', '佛山',
    '中山', '惠州' // 副省级 / 经济强市
  ];

  if (provincialCapitals.includes(trimmed)) {
    return '二线';
  }

  // 关键词匹配兜底
  for (const keyword of TIER2_KEYWORDS) {
    if (trimmed.includes(keyword)) {
      return '二线';
    }
  }

  return '三四线';
}

// ============================================================================
// 评分辅助函数
// ============================================================================

/**
 * 将数值限制在 [min, max] 区间内
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * 安全获取嵌套对象属性值
 * @param {object} obj
 * @param {string} path - 点分隔路径，如 'competition.rings.core'
 * @param {*} defaultValue
 * @returns {*}
 */
function getNestedValue(obj, path, defaultValue = undefined) {
  if (!obj || !path) return defaultValue;
  const keys = path.split('.');
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') {
      return defaultValue;
    }
    current = current[key];
  }
  return current !== undefined ? current : defaultValue;
}

/**
 * 从核心圈 cuisine_breakdown 中计算目标品类的占比
 * @param {object} cuisineBreakdown - 品类分布，如 { "火锅": 12, "川菜": 20 }
 * @param {string} restaurantType - 目标品类，如 "火锅"
 * @returns {{ count: number, ratio: number, totalCount: number }}
 */
function calcCategoryRatio(cuisineBreakdown, restaurantType) {
  if (!cuisineBreakdown || typeof cuisineBreakdown !== 'object') {
    return { count: 0, ratio: 0, totalCount: 0 };
  }

  const entries = Object.entries(cuisineBreakdown);
  const totalCount = entries.reduce((sum, [, v]) => sum + (Number(v) || 0), 0);
  const targetCount = Number(cuisineBreakdown[restaurantType]) || 0;
  const ratio = totalCount > 0 ? targetCount / totalCount : 0;

  return { count: targetCount, ratio, totalCount };
}

// ============================================================================
// 维度 1：战略因素 (Strategic Factors) - 20 分
// ============================================================================

/**
 * 评估战略因素得分
 *
 * 子项：
 *   - 城市等级 (8 分)：一线=8, 新一线=6, 二线=4, 三四线=2
 *   - 商圈类型 (7 分)：commercial=7, mixed=4, residential=2
 *   - 发展趋势 (5 分)：基于商圈类型与交通便利度的启发式判断
 *
 * @param {string} city - 城市名
 * @param {string} areaType - 商圈类型
 * @param {number} transitScore - 交通得分 (0-10)
 * @returns {{ score: number, details: object }}
 */
function scoreStrategic(city, areaType, transitScore) {
  // --- 城市等级 ---
  const cityTier = classifyCityTier(city);
  const tierScoreMap = { '一线': 8, '新一线': 6, '二线': 4, '三四线': 2 };
  const cityScore = tierScoreMap[cityTier] || 2;

  // --- 商圈类型 ---
  const areaScoreMap = { commercial: 7, mixed: 4, residential: 2 };
  const areaScore = areaScoreMap[areaType] || 2;

  // --- 发展趋势（启发式） ---
  // 逻辑：商业区 + 交通便利 → 发展中区域（得分最高）
  //       纯商业区 → 已成熟（中等）
  //       住宅区 → 发展潜力有限（最低）
  let trendScore;
  if (areaType === 'commercial' && transitScore >= 6) {
    trendScore = 5; // 发展中区域：商业 + 交通便利
  } else if (areaType === 'commercial') {
    trendScore = 3; // 成熟商业区
  } else if (areaType === 'mixed') {
    trendScore = 3; // 混合区域有一定发展潜力
  } else {
    trendScore = 2; // 住宅区
  }

  const total = clamp(cityScore + areaScore + trendScore, 0, 20);

  return {
    score: total,
    details: {
      city_tier: cityTier,
      city_score: cityScore,
      area_type: areaType,
      area_score: areaScore,
      trend_score: trendScore
    }
  };
}

// ============================================================================
// 维度 2：竞争因素 (Competition Factors) - 20 分
// ============================================================================

/**
 * 评估竞争因素得分
 *
 * 【反直觉逻辑说明】
 * 竞争密度高 → 说明该区域餐饮市场已被验证，有足够的消费需求。
 * 对于有差异化能力的品牌，高密度竞争区域是"被证明的市场"，
 * 比冷门区域风险更低。因此竞争越多，得分越高。
 *
 * 同品类占比低 → 说明虽有竞争但目标品类仍有差异化空间，给予加分。
 * 同品类完全不存在 → 也说明有切入空白市场的机会，同样给满分。
 *
 * 子项：
 *   - 核心圈（150m）密度 (15 分)：>100=15, 75-100=12, 50-75=8, 30-50=4, <30=0
 *   - 同品类占比奖励 (5 分)：占比<15% 或完全不存在 = 5 分
 *
 * @param {object} coreRing - 核心圈数据
 * @param {string} restaurantType - 目标餐饮品类
 * @returns {{ score: number, details: object }}
 */
function scoreCompetition(coreRing, restaurantType) {
  const coreCount = getNestedValue(coreRing, 'total_count', 0);
  const cuisineBreakdown = getNestedValue(coreRing, 'cuisine_breakdown', {});

  // --- 核心圈密度得分 ---
  let densityScore;
  if (coreCount > 100) {
    densityScore = 15;
  } else if (coreCount >= 75) {
    densityScore = 12;
  } else if (coreCount >= 50) {
    densityScore = 8;
  } else if (coreCount >= 30) {
    densityScore = 4;
  } else {
    densityScore = 0;
  }

  // --- 同品类占比奖励 ---
  const { count: categoryCount, ratio: categoryRatio } = calcCategoryRatio(
    cuisineBreakdown,
    restaurantType
  );

  let categoryBonus;
  if (categoryCount === 0) {
    // 该品类完全不存在 → 空白市场机会
    categoryBonus = 5;
  } else if (categoryRatio < 0.15) {
    // 占比低于 15% → 差异化空间充足
    categoryBonus = 5;
  } else if (categoryRatio < 0.25) {
    // 占比 15%-25% → 有一定空间但竞争加剧
    categoryBonus = 3;
  } else {
    // 占比过高 → 红海市场，无额外奖励
    categoryBonus = 0;
  }

  const total = clamp(densityScore + categoryBonus, 0, 20);

  return {
    score: total,
    details: {
      core_density: coreCount,
      density_score: densityScore,
      same_category_count: categoryCount,
      same_category_ratio: Number(categoryRatio.toFixed(4)),
      category_bonus: categoryBonus
    }
  };
}

// ============================================================================
// 维度 3：销售潜力 (Sales Potential) - 20 分
// ============================================================================

/**
 * 评估销售潜力得分
 *
 * 子项：
 *   - 人流代理指标 (12 分)：
 *     * 内环 (500m) POI 总量：>=100=6, >=50=4, >=20=2, 否则=0
 *     * 交通站点数量：>=3=3, >=1=2, 否则=0
 *     * 互补商业数量：>=5=3, >=2=1, 否则=0
 *   - 截流率估算 (8 分)：基于商圈类型与竞争密度的组合判断
 *
 * @param {object} innerRing - 内环数据
 * @param {object} profile - 区域画像
 * @param {string} areaType - 商圈类型
 * @param {number} coreCount - 核心圈 POI 数量
 * @returns {{ score: number, details: object }}
 */
function scoreSales(innerRing, profile, areaType, coreCount) {
  const innerTotal = getNestedValue(innerRing, 'total_count', 0);

  // --- 人流代理 (12 分) ---

  // 内环 POI 总量得分 (6 分)
  let innerPoiScore;
  if (innerTotal >= 100) {
    innerPoiScore = 6;
  } else if (innerTotal >= 50) {
    innerPoiScore = 4;
  } else if (innerTotal >= 20) {
    innerPoiScore = 2;
  } else {
    innerPoiScore = 0;
  }

  // 交通站点数量得分 (3 分)
  // 从 profile 的 transitDetails 推算站点数量，若无则用 transitScore 做近似
  const transitDetails = getNestedValue(profile, 'transitDetails', []);
  const transitStationCount = Array.isArray(transitDetails) ? transitDetails.length : 0;
  let transitStationScore;
  if (transitStationCount >= 3) {
    transitStationScore = 3;
  } else if (transitStationCount >= 1) {
    transitStationScore = 2;
  } else {
    // 兜底：如果没有 transitDetails，用 transitScore 做近似
    const transitScore = getNestedValue(profile, 'transitScore', 0);
    if (transitScore >= 7) {
      transitStationScore = 3;
    } else if (transitScore >= 4) {
      transitStationScore = 2;
    } else {
      transitStationScore = 0;
    }
  }

  // 互补商业得分 (3 分)
  const complementaryDetails = getNestedValue(profile, 'complementaryDetails', []);
  const complementaryCount = Array.isArray(complementaryDetails)
    ? complementaryDetails.length
    : 0;
  let complementaryScore;
  if (complementaryCount >= 5) {
    complementaryScore = 3;
  } else if (complementaryCount >= 2) {
    complementaryScore = 1;
  } else {
    // 兜底：用 complementaryScore 字段近似
    const compScoreRaw = getNestedValue(profile, 'complementaryScore', 0);
    if (compScoreRaw >= 7) {
      complementaryScore = 3;
    } else if (compScoreRaw >= 4) {
      complementaryScore = 1;
    } else {
      complementaryScore = 0;
    }
  }

  const footTrafficProxy = innerPoiScore + transitStationScore + complementaryScore;

  // --- 截流率估算 (8 分) ---
  // 逻辑：商业区 + 高密度竞争 → 已验证市场，食客主动聚集，截流率最高
  const isDenseCompetition = coreCount > 50;
  const isModerateCompetition = coreCount >= 20 && coreCount <= 50;
  const isLowCompetition = coreCount < 20;

  let captureScore;
  if (areaType === 'commercial' && isDenseCompetition) {
    captureScore = 8; // 已验证的高客流市场
  } else if (areaType === 'commercial' && isModerateCompetition) {
    captureScore = 6; // 商业区 + 适度竞争
  } else if (areaType === 'mixed' && isModerateCompetition) {
    captureScore = 4; // 混合区域 + 适度竞争
  } else if (areaType === 'mixed' && isDenseCompetition) {
    captureScore = 5; // 混合区域但竞争密集
  } else if (areaType === 'residential' && isLowCompetition) {
    captureScore = 2; // 住宅区竞争少，客流有限
  } else {
    captureScore = 1; // 其他情况
  }

  const total = clamp(footTrafficProxy + captureScore, 0, 20);

  return {
    score: total,
    details: {
      inner_ring_total: innerTotal,
      inner_poi_score: innerPoiScore,
      transit_station_count: transitStationCount,
      transit_station_score: transitStationScore,
      complementary_count: complementaryCount,
      complementary_traffic_score: complementaryScore,
      foot_traffic_proxy: footTrafficProxy,
      capture_estimate: captureScore
    }
  };
}

// ============================================================================
// 维度 4：服务配套 (Service Infrastructure) - 20 分
// ============================================================================

/**
 * 评估服务配套得分
 *
 * 直接使用区域画像中已计算好的评分（0-10 分制），各占 10 分。
 *
 * 子项：
 *   - 互补商业配套 (10 分)：profile.complementaryScore（已为 0-10）
 *   - 交通可达性 (10 分)：profile.transitScore（已为 0-10）
 *
 * @param {object} profile - 区域画像
 * @returns {{ score: number, details: object }}
 */
function scoreService(profile) {
  const complementaryScore = clamp(
    getNestedValue(profile, 'complementaryScore', 0),
    0,
    10
  );
  const transitScore = clamp(
    getNestedValue(profile, 'transitScore', 0),
    0,
    10
  );

  const total = clamp(complementaryScore + transitScore, 0, 20);

  return {
    score: total,
    details: {
      complementary_score: complementaryScore,
      transit_score: transitScore
    }
  };
}

// ============================================================================
// 维度 5：立地条件 (Location Conditions) - 20 分
// ============================================================================

/**
 * 评估立地条件得分
 *
 * 子项：
 *   - 区域类型 (10 分)：commercial=10, mixed=6, residential=3
 *   - 街道可达性代理 (5 分)：内环 POI 密度高 → 主街道
 *     * inner > 80 = 5, > 30 = 3, 否则 = 1
 *   - 物业可行性 (5 分)：commercial=5, mixed=3, residential=2
 *
 * @param {string} areaType - 商圈类型
 * @param {number} innerTotal - 内环 POI 总数
 * @returns {{ score: number, details: object }}
 */
function scoreConditions(areaType, innerTotal) {
  // --- 区域类型 (10 分) ---
  const zoneScoreMap = { commercial: 10, mixed: 6, residential: 3 };
  const zoneScore = zoneScoreMap[areaType] || 3;

  // --- 街道可达性代理 (5 分) ---
  // 内环 POI 密度越高，说明该区域位于主要街道上
  let streetScore;
  if (innerTotal > 80) {
    streetScore = 5;
  } else if (innerTotal > 30) {
    streetScore = 3;
  } else {
    streetScore = 1;
  }

  // --- 物业可行性 (5 分) ---
  const propertyScoreMap = { commercial: 5, mixed: 3, residential: 2 };
  const propertyScore = propertyScoreMap[areaType] || 2;

  const total = clamp(zoneScore + streetScore + propertyScore, 0, 20);

  return {
    score: total,
    details: {
      zone_type: areaType,
      zone_score: zoneScore,
      street_accessibility: streetScore,
      inner_ring_poi_for_street: innerTotal,
      property_feasibility: propertyScore
    }
  };
}

// ============================================================================
// 等级与建议映射
// ============================================================================

/**
 * 根据总分映射评估等级
 * @param {number} total - 总分 (0-100)
 * @returns {string} 等级: '优秀' | '良好' | '及格' | '不推荐'
 */
function getGrade(total) {
  if (total >= 80) return '优秀';
  if (total >= 60) return '良好';
  if (total >= 40) return '及格';
  return '不推荐';
}

/**
 * 根据总分映射行动建议
 * @param {number} total - 总分 (0-100)
 * @returns {string} 建议: '立即行动' | '可以进驻' | '谨慎考虑' | '建议放弃'
 */
function getRecommendation(total) {
  if (total >= 80) return '立即行动';
  if (total >= 60) return '可以进驻';
  if (total >= 40) return '谨慎考虑';
  return '建议放弃';
}

// ============================================================================
// 主评分函数
// ============================================================================

/**
 * 对单个候选选址进行 100 分制综合评分
 *
 * @param {object} areaData - 区域数据（来自 competition-scanner + area-profiler）
 * @param {object} siteIntent - 选址意图（来自 site-intent-parser）
 * @returns {object} 评分结果，包含总分、维度分项、等级、建议和明细
 *
 * @example
 *   const result = scoreSite(
 *     { competition: { rings: { core: {...}, inner: {...} } }, profile: {...} },
 *     { restaurant_type: '火锅', city: '成都', ... }
 *   );
 *   console.log(result.total);  // 82
 *   console.log(result.grade);  // '良好'
 */
function scoreSite(areaData, siteIntent) {
  if (!areaData || typeof areaData !== 'object') {
    throw new Error('[选址评分] areaData 参数不能为空');
  }
  if (!siteIntent || typeof siteIntent !== 'object') {
    throw new Error('[选址评分] siteIntent 参数不能为空');
  }

  const city = siteIntent.city || '';
  const restaurantType = siteIntent.restaurant_type || '';
  const areaName = siteIntent.target_areas
    ? (Array.isArray(siteIntent.target_areas)
      ? siteIntent.target_areas[0]
      : siteIntent.target_areas)
    : '未知区域';

  // 提取区域数据
  const rings = getNestedValue(areaData, 'competition.rings', {});
  const coreRing = rings.core || {};
  const innerRing = rings.inner || {};
  const profile = areaData.profile || {};
  const areaType = profile.areaType || 'mixed';
  const transitScore = getNestedValue(profile, 'transitScore', 0);

  console.log(`[选址评分] 开始评估: ${areaName} (${city}) - 品类: ${restaurantType}`);

  // 5 大维度分别评分
  const strategic = scoreStrategic(city, areaType, transitScore);
  const competition = scoreCompetition(coreRing, restaurantType);

  const coreCount = getNestedValue(coreRing, 'total_count', 0);
  const sales = scoreSales(innerRing, profile, areaType, coreCount);
  const service = scoreService(profile);

  const innerTotal = getNestedValue(innerRing, 'total_count', 0);
  const conditions = scoreConditions(areaType, innerTotal);

  // 汇总
  const total = clamp(
    strategic.score + competition.score + sales.score + service.score + conditions.score,
    0,
    100
  );

  const grade = getGrade(total);
  const recommendation = getRecommendation(total);

  console.log(`[选址评分] 总分: ${total} | 等级: ${grade} | 建议: ${recommendation}`);
  console.log(`[选址评分] 分项: 战略=${strategic.score} 竞争=${competition.score} 销售=${sales.score} 服务=${service.score} 立地=${conditions.score}`);

  return {
    area_name: areaName,
    total,
    breakdown: {
      strategic: strategic.score,
      competition: competition.score,
      sales: sales.score,
      service: service.score,
      conditions: conditions.score
    },
    grade,
    recommendation,
    details: {
      // 战略因素明细
      city_tier: strategic.details.city_tier,
      city_score: strategic.details.city_score,
      area_type: strategic.details.area_type,
      area_score: strategic.details.area_score,
      trend_score: strategic.details.trend_score,

      // 竞争因素明细
      core_density: competition.details.core_density,
      density_score: competition.details.density_score,
      same_category_count: competition.details.same_category_count,
      same_category_ratio: competition.details.same_category_ratio,
      category_bonus: competition.details.category_bonus,

      // 销售潜力明细
      inner_ring_total: sales.details.inner_ring_total,
      foot_traffic_proxy: sales.details.foot_traffic_proxy,
      capture_estimate: sales.details.capture_estimate,
      inner_poi_score: sales.details.inner_poi_score,
      transit_station_score: sales.details.transit_station_score,
      complementary_traffic_score: sales.details.complementary_traffic_score,

      // 服务配套明细
      complementary_score: service.details.complementary_score,
      transit_score: service.details.transit_score,

      // 立地条件明细
      zone_score: conditions.details.zone_score,
      street_accessibility: conditions.details.street_accessibility,
      property_feasibility: conditions.details.property_feasibility
    }
  };
}

// ============================================================================
// 多站点比较函数
// ============================================================================

/** 5 大评分维度的中文名称映射 */
const DIMENSION_NAMES = {
  strategic: '战略',
  competition: '竞争',
  sales: '销售',
  service: '服务',
  conditions: '立地'
};

/**
 * 对多个候选选址进行横向比较与排名
 *
 * @param {Array<object>} siteScores - scoreSite() 返回结果的数组
 * @returns {object} 比较结果，包含排名、最佳推荐、各维度对比
 *
 * @example
 *   const comparison = compareSites([score1, score2, score3]);
 *   console.log(comparison.best.area_name);  // '春熙路'
 */
function compareSites(siteScores) {
  if (!Array.isArray(siteScores) || siteScores.length === 0) {
    throw new Error('[选址评分] compareSites 需要至少一个评分结果');
  }

  console.log(`[选址评分] 开始比较 ${siteScores.length} 个候选选址`);

  // --- 按总分降序排名 ---
  const ranking = [...siteScores].sort((a, b) => b.total - a.total);

  // --- 最佳推荐 ---
  const best = {
    area_name: ranking[0].area_name,
    total: ranking[0].total,
    reason: '综合评分最高'
  };

  // --- 各维度横向对比 ---
  const comparison = [];

  for (const [dimKey, dimName] of Object.entries(DIMENSION_NAMES)) {
    // 找出该维度得分最高和最低的站点
    let bestSite = ranking[0];
    let worstSite = ranking[0];

    for (const site of ranking) {
      const siteVal = getNestedValue(site, `breakdown.${dimKey}`, 0);
      const bestVal = getNestedValue(bestSite, `breakdown.${dimKey}`, 0);
      const worstVal = getNestedValue(worstSite, `breakdown.${dimKey}`, 0);

      if (siteVal > bestVal) {
        bestSite = site;
      }
      if (siteVal < worstVal) {
        worstSite = site;
      }
    }

    const bestVal = getNestedValue(bestSite, `breakdown.${dimKey}`, 0);
    const worstVal = getNestedValue(worstSite, `breakdown.${dimKey}`, 0);

    comparison.push({
      dimension: dimName,
      best: `${bestSite.area_name}(${bestVal})`,
      worst: `${worstSite.area_name}(${worstVal})`
    });
  }

  // 打印排名摘要
  console.log('[选址评分] ===== 排名结果 =====');
  ranking.forEach((site, idx) => {
    console.log(`[选址评分]   #${idx + 1} ${site.area_name}: ${site.total}分 (${site.grade})`);
  });
  console.log(`[选址评分] 推荐选址: ${best.area_name} - ${best.reason}`);

  return {
    ranking,
    best,
    comparison
  };
}

// ============================================================================
// CLI 测试模式
// ============================================================================

if (require.main === module) {
  console.log('[选址评分] ===== CLI 测试模式 =====\n');

  // 模拟区域数据（来自 competition-scanner + area-profiler）
  const mockAreaData1 = {
    competition: {
      rings: {
        core: {
          total_count: 87,
          cuisine_breakdown: { '火锅': 12, '川菜': 20, '日料': 8, '烧烤': 10, '奶茶': 15, '快餐': 22 },
          avg_rating: 4.1,
          avg_cost: 65
        },
        inner: {
          total_count: 156,
          cuisine_breakdown: {},
          pois: []
        },
        middle: { total_count: 420 },
        outer: { total_count: 1200 }
      }
    },
    profile: {
      areaType: 'commercial',
      commercialRatio: 0.65,
      transitScore: 8,
      complementaryScore: 7,
      transitDetails: [
        { name: '春熙路站', type: 'metro', distance: 200 },
        { name: '天府广场站', type: 'metro', distance: 450 },
        { name: '春熙路北口', type: 'bus', distance: 100 }
      ],
      complementaryDetails: [
        { name: 'IFS 国际金融中心', type: 'shopping' },
        { name: '太古里', type: 'shopping' },
        { name: '王府井百货', type: 'shopping' },
        { name: '万达影城', type: 'entertainment' },
        { name: '大慈寺停车场', type: 'parking' },
        { name: '春熙路社区卫生服务中心', type: 'medical' }
      ]
    }
  };

  // 模拟第二个候选区域（建设路）
  const mockAreaData2 = {
    competition: {
      rings: {
        core: {
          total_count: 45,
          cuisine_breakdown: { '火锅': 3, '川菜': 15, '烧烤': 8, '小吃': 12 },
          avg_rating: 3.9,
          avg_cost: 45
        },
        inner: {
          total_count: 68,
          cuisine_breakdown: {},
          pois: []
        },
        middle: { total_count: 200 },
        outer: { total_count: 800 }
      }
    },
    profile: {
      areaType: 'mixed',
      commercialRatio: 0.40,
      transitScore: 5,
      complementaryScore: 4,
      transitDetails: [
        { name: '建设路站', type: 'metro', distance: 300 }
      ],
      complementaryDetails: [
        { name: '建设路万达广场', type: 'shopping' },
        { name: '伊藤洋华堂', type: 'shopping' },
        { name: '建设路停车场', type: 'parking' }
      ]
    }
  };

  // 模拟第三个候选区域（住宅区）
  const mockAreaData3 = {
    competition: {
      rings: {
        core: {
          total_count: 18,
          cuisine_breakdown: { '川菜': 5, '快餐': 6, '面馆': 4 },
          avg_rating: 3.7,
          avg_cost: 30
        },
        inner: {
          total_count: 30,
          cuisine_breakdown: {},
          pois: []
        },
        middle: { total_count: 100 },
        outer: { total_count: 400 }
      }
    },
    profile: {
      areaType: 'residential',
      commercialRatio: 0.15,
      transitScore: 3,
      complementaryScore: 3,
      transitDetails: [],
      complementaryDetails: [
        { name: '社区超市', type: 'shopping' }
      ]
    }
  };

  // 模拟选址意图
  const mockSiteIntent = {
    restaurant_type: '火锅',
    city: '成都',
    budget_rent: 20000,
    target_areas: ['春熙路'],
    store_type: '都可以',
    target_customers: '',
    experience_level: '新手'
  };

  // --- 测试单站点评分 ---
  console.log('--- 测试 1: 春熙路 ---');
  const intent1 = { ...mockSiteIntent, target_areas: ['春熙路'] };
  const result1 = scoreSite(mockAreaData1, intent1);
  console.log(JSON.stringify(result1, null, 2));
  console.log();

  console.log('--- 测试 2: 建设路 ---');
  const intent2 = { ...mockSiteIntent, target_areas: ['建设路'] };
  const result2 = scoreSite(mockAreaData2, intent2);
  console.log(JSON.stringify(result2, null, 2));
  console.log();

  console.log('--- 测试 3: 华阳住宅区 ---');
  const intent3 = { ...mockSiteIntent, target_areas: ['华阳住宅区'] };
  const result3 = scoreSite(mockAreaData3, intent3);
  console.log(JSON.stringify(result3, null, 2));
  console.log();

  // --- 测试多站点比较 ---
  console.log('--- 测试 4: 多站点比较 ---');
  const comparison = compareSites([result1, result2, result3]);
  console.log(JSON.stringify(comparison, null, 2));
  console.log();

  // --- 测试城市等级分类 ---
  console.log('--- 测试 5: 城市等级分类 ---');
  const testCities = ['北京', '成都', '厦门', '绵阳', '武汉', '拉萨'];
  for (const city of testCities) {
    console.log(`[选址评分]   ${city} → ${classifyCityTier(city)}`);
  }
}

// ============================================================================
// 模块导出
// ============================================================================

module.exports = { scoreSite, compareSites, classifyCityTier };
