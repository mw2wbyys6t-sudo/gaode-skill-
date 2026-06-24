/**
 * 次元旅人 - 智能旅游路线优化器
 *
 * 核心算法流程:
 *   1. 过滤阶段 - 剔除不匹配用户偏好/体力限制的景点
 *   2. 评分阶段 - 综合计算每个景点的匹配分数
 *   3. 选择阶段 - 贪心选择，在时间预算内尽可能选高分景点
 *   4. 排序阶段 - 最近邻 TSP 启发式确定游览顺序
 *   5. 优化阶段 - 2-opt 局部搜索缩短步行总距离
 *   6. 路线生成 - 调用高德步行 API 获取真实路线
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

// ========================== 配置读取 ==========================

/**
 * 读取高德 WebService Key，优先级:
 *   1. config.json 中的 amapWebServiceKey
 *   2. 环境变量 AMAP_WEBSERVICE_KEY
 *   3. 测试用 fallback key
 */
function loadConfig() {
  let config = {};
  const configPaths = [
    path.join(__dirname, '..', 'config.json'),
    path.join(__dirname, 'config.json'),
  ];
  for (const p of configPaths) {
    try {
      if (fs.existsSync(p)) {
        config = JSON.parse(fs.readFileSync(p, 'utf8'));
        break;
      }
    } catch (_) { /* 忽略读取失败 */ }
  }

  const key = config.amapWebServiceKey
    || process.env.AMAP_WEBSERVICE_KEY
    || 'f0f99d37a1379881c4d77d45d98b05a6';

  return { ...config, amapWebServiceKey: key, appName: 'smart-tourism-planner' };
}

// ========================== 工具函数 ==========================

const EARTH_RADIUS_M = 6371000; // 地球平均半径（米）

/**
 * Haversine 公式 - 估算两个经纬度点之间的直线距离（米）
 * 用于距离矩阵的快速估算，减少 API 调用次数
 */
function haversine(lat1, lon1, lat2, lon2) {
  // 输入验证：任何无效坐标返回 Infinity，让调用方可以检测并处理
  if (!Number.isFinite(lat1) || !Number.isFinite(lon1) ||
      !Number.isFinite(lat2) || !Number.isFinite(lon2)) {
    return Infinity;
  }
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 根据 POI 类型字段判断分类（轻量版，不依赖 scenic-data-fetcher）
 * @param {string} type - POI type 字符串
 * @returns {string} 'scenic' | 'food' | 'drink' | 'parking'
 */
function categorizePoiByType(type) {
  if (!type) return 'scenic';
  if (type.includes('餐饮') || type.includes('餐厅') || type.includes('小吃') ||
      type.includes('快餐') || type.includes('美食') || type.includes('地方风味')) {
    return 'food';
  }
  if (type.includes('咖啡') || type.includes('茶') || type.includes('甜品') || type.includes('饮品')) {
    return 'drink';
  }
  return 'scenic';
}

/**
 * 简易 HTTP/HTTPS GET 请求封装，返回 JSON
 */
function httpGet(url) {
  const lib = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    lib.get(url, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end',  () => {
        try { resolve(JSON.parse(body)); }
        catch (e)   { reject(new Error(`JSON 解析失败: ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject)
      .on('timeout', function () { this.destroy(); reject(new Error('请求超时')); });
  });
}

/**
 * 步行速度（米/分钟），根据体力等级调整
 *   low    = 60 m/min  (慢走)
 *   medium = 80 m/min  (正常)
 *   high   = 100 m/min (快走)
 */
function walkSpeedMetersPerMin(physicalLevel) {
  const speeds = { low: 60, medium: 80, high: 100 };
  return speeds[physicalLevel] || speeds.medium;
}

/**
 * 获取 POI 的经纬度（兼容 location.lng/lat 和顶层 lng/lat/lon 格式）
 * @returns {{ lng: number, lat: number }} 坐标对象，缺失时返回 NaN
 */
function getCoords(poi) {
  const lng = poi.location?.lng ?? poi.lng ?? poi.lon ?? NaN;
  const lat = poi.location?.lat ?? poi.lat ?? NaN;
  return { lng, lat };
}

/**
 * 检查 POI 是否有有效的经纬度坐标
 * @param {object} poi
 * @returns {boolean}
 */
function hasValidCoords(poi) {
  const { lng, lat } = getCoords(poi);
  return Number.isFinite(lng) && Number.isFinite(lat) && (lng !== 0 || lat !== 0);
}

/**
 * 根据 Haversine 距离估算步行时间（分钟）
 * 乘 1.3 的绕路系数，使估算更贴近真实步行路径
 */
function estimateWalkMinutes(distMeters, physicalLevel) {
  const speed = walkSpeedMetersPerMin(physicalLevel);
  return Math.round((distMeters * 1.3) / speed);
}

// ========================== 过滤阶段 ==========================

/**
 * 过滤不符合用户兴趣和体力限制的 POI
 *
 * 规则:
 *   - 如果用户指定了 interests，则 POI 的 tags 中至少要有一个匹配
 *   - 如果用户 physical_level 为 low，则剔除 tags 含 "爬山"/"徒步" 的高体力 POI
 *   - suggested_duration <= 0 的 POI 直接剔除
 */
function filterPois(pois, preferences) {
  if (!pois || pois.length === 0) return [];

  const { interests = [], physical_level = 'medium' } = preferences;

  // 高体力消耗标签，体力等级 low 时剔除
  const heavyTags = ['爬山', '徒步', '攀岩', '登山', 'hiking', 'climbing'];

  // 标准化 POI 字段（兼容 suggested_duration / suggested_duration_minutes）
  const normalized = pois.map((poi) => {
    const duration = poi.suggested_duration_minutes || poi.suggested_duration || 0;
    const priority = poi.priority != null && poi.priority > 0
      ? Math.min(poi.priority / 100, 1)  // 统一按 0-100 归一化到 0-1
      : 0.5;
    return { ...poi, _duration: duration, _priority: priority };
  });

  let filtered = normalized.filter((poi) => {
    // 坐标无效（缺失或为 0,0）的 POI 直接剔除，避免产生数千公里的步行路段
    if (!hasValidCoords(poi)) return false;

    // 游览时长无效的 POI 剔除
    if (!poi._duration || poi._duration <= 0) return false;

    // 体力限制过滤
    if (physical_level === 'low' && poi.tags) {
      const isHeavy = poi.tags.some((t) => heavyTags.includes(t));
      if (isHeavy) return false;
    }

    return true;
  });

  // 兴趣标签匹配（宽松模式：如果严格过滤后无 POI 则跳过兴趣过滤）
  // 类型 → 兴趣的关联映射（"风景名胜"可匹配多种兴趣）
  const typeInterestMap = {
    '风景名胜': ['自然风光', '观光', '摄影', '历史文化'],
    '旅游景点': ['自然风光', '观光', '历史文化', '亲子'],
    '寺庙': ['古建筑', '历史文化', '宗教'],
    '公园': ['自然风光', '亲子', '散步'],
    '博物馆': ['历史文化', '亲子'],
  };

  if (interests.length > 0 && filtered.length > 0) {
    const interestFiltered = filtered.filter((poi) => {
      if (!poi.tags || poi.tags.length === 0) return true; // 无标签的保留
      // 匹配 POI 的 type 字段
      if (poi.type) {
        if (interests.some((i) => poi.type.includes(i) || i.includes(poi.type))) return true;
        // 通过类型映射表匹配
        const relatedInterests = typeInterestMap[poi.type] || [];
        if (interests.some((i) => relatedInterests.includes(i))) return true;
      }
      // tags 匹配
      return poi.tags.some((t) =>
        interests.some((i) => i === t || (typeof i === 'string' && typeof t === 'string' && (i.includes(t) || t.includes(i))))
      );
    });
    // 如果兴趣过滤后还有 POI，使用过滤结果；否则保留全部（宽松模式）
    if (interestFiltered.length > 0) {
      filtered = interestFiltered;
    }
  }

  return filtered;
}

// ========================== 评分阶段 ==========================

/**
 * 综合评分 = 兴趣匹配(0.4) + 优先级(0.3) + 时间适配(0.3)
 *
 * interest_match: POI tags 与用户 interests 的重合度 (0~1)
 * priority:       POI 自带优先级归一化 (0~1)，默认 0.5
 * duration_fit:   POI 游览时长与剩余时间的契合度 (0~1)
 */
function scorePois(pois, preferences) {
  const { interests = [], duration_hours = 4 } = preferences;
  const totalMinutes = duration_hours * 60;

  return pois.map((poi) => {
    // --- 兴趣匹配分 ---
    let interestMatch = 0.5; // 默认中间值（用户未指定 interests 时）
    if (interests.length > 0 && poi.tags && poi.tags.length > 0) {
      const hits = poi.tags.filter((t) =>
        interests.some((i) => i === t || i.includes(t) || t.includes(i))
      );
      interestMatch = Math.max(hits.length / interests.length, 0.1);
      // POI 的 type 字段匹配也加分
      if (poi.type && interests.some((i) => poi.type.includes(i) || i.includes(poi.type))) {
        interestMatch = Math.max(interestMatch, 0.6);
      }
    }

    // --- 优先级分（使用标准化的 _priority，范围 0-1）---
    const priority = poi._priority != null ? poi._priority : (poi.priority > 1 ? poi.priority / 100 : (poi.priority || 0.5));

    // --- 时间适配分（兼容 _duration / suggested_duration / suggested_duration_minutes）---
    const duration = poi._duration || poi.suggested_duration || poi.suggested_duration_minutes || 30;
    const ratio = duration / totalMinutes;
    let durationFit;
    if (ratio <= 0.5) {
      durationFit = 1.0;                         // 时长在预算一半以内，满分
    } else if (ratio <= 1.0) {
      durationFit = 1.0 - (ratio - 0.5) * 0.6;  // 线性衰减到 0.7
    } else {
      durationFit = 0.3;                          // 超出预算，低分但不完全排除
    }

    let score = interestMatch * 0.4 + priority * 0.3 + durationFit * 0.3;

    // v2: 美食专注度加成
    const foodPrefs = preferences.food_preferences;
    if (foodPrefs) {
      const category = poi._category || categorizePoiByType(poi.type);
      if (foodPrefs.food_focus && (category === 'food' || category === 'drink')) {
        score *= 1.5;
      }
      // 菜系匹配加成
      if (foodPrefs.cuisine_types && foodPrefs.cuisine_types.length > 0 && category === 'food') {
        const cuisineMatch = foodPrefs.cuisine_types.some(c => 
          (poi._cuisine_type || '').includes(c) || (poi.type || '').includes(c)
        );
        if (cuisineMatch) score *= 1.2;
      }
    }

    return { ...poi, _score: score, _interestMatch: interestMatch, _durationFit: durationFit };
  });
}

// ========================== 选择阶段 ==========================

/**
 * 贪心选择 - 按分数从高到低，依次加入景点直到时间预算耗尽
 * 每次加入时累加: 游览时间 + 预估步行时间（与上一个选中景点之间）
 */
function selectPois(scoredPois, preferences) {
  const { duration_hours = 4, physical_level = 'medium' } = preferences;
  const budgetMinutes = duration_hours * 60;

  // 按分数降序排列
  const sorted = [...scoredPois].sort((a, b) => b._score - a._score);

  const selected = [];
  let usedMinutes = 0;

  for (const poi of sorted) {
    // 估算与上一个选中景点之间的步行时间
    let walkMin = 0;
    if (selected.length > 0) {
      const last = getCoords(selected[selected.length - 1]);
      const curr = getCoords(poi);
      const dist = haversine(last.lat, last.lng, curr.lat, curr.lng);
      walkMin = estimateWalkMinutes(dist, physical_level);
    }

    const duration = poi._duration || poi.suggested_duration || poi.suggested_duration_minutes || 30;
    const needed = duration + walkMin;
    if (usedMinutes + needed > budgetMinutes) continue; // 放不下就跳过

    selected.push(poi);
    usedMinutes += needed;
  }

  return selected;
}

// ========================== 排序阶段 ==========================

/**
 * 最近邻 TSP 启发式 - 从第一个选中的景点出发
 * 每步选离当前位置最近的未访问景点
 */
function orderPoisNN(selected) {
  if (selected.length <= 1) return selected;

  const remaining = [...selected];
  const ordered = [remaining.shift()]; // 从第一个景点出发

  while (remaining.length > 0) {
    const current = ordered[ordered.length - 1];
    let bestIdx = 0;
    let bestDist = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const c = getCoords(current);
      const r = getCoords(remaining[i]);
      const d = haversine(c.lat, c.lng, r.lat, r.lng);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }

    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }

  return ordered;
}

/**
 * 计算路线总 Haversine 距离（米）
 */
function totalHaversineDist(ordered) {
  let total = 0;
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = getCoords(ordered[i]);
    const b = getCoords(ordered[i + 1]);
    total += haversine(a.lat, a.lng, b.lat, b.lng);
  }
  return total;
}

// ========================== 优化阶段 ==========================

/**
 * 2-opt 局部搜索 - 通过反复反转子路径来缩短总步行距离
 * 迭代直到无法找到更优的交换为止（最多 100 轮防止死循环）
 */
function twoOptImprove(ordered) {
  if (ordered.length < 3) return ordered;

  let improved = true;
  let best = [...ordered];
  let iterations = 0;
  const MAX_ITER = 100;

  while (improved && iterations < MAX_ITER) {
    improved = false;
    iterations++;
    let bestDist = totalHaversineDist(best);

    for (let i = 1; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        // 反转 [i, j] 区间的子路径
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, j + 1).reverse(),
          ...best.slice(j + 1),
        ];
        const candDist = totalHaversineDist(candidate);
        if (candDist < bestDist - 1) { // 至少改善 1 米才算有效
          best = candidate;
          bestDist = candDist;
          improved = true;
        }
      }
    }
  }

  return best;
}

// ========================== 路线生成 ==========================

/**
 * 调用高德步行路径规划 API 获取两点之间的实际步行路线
 * 文档: https://lbs.amap.com/api/webservice/guide/api/direction#t7
 *
 * 返回: { walking_minutes, walking_meters, route_coords }
 * API 失败时回退到 Haversine 估算
 */
async function fetchWalkingRoute(fromPoi, toPoi, config) {
  const key = config.amapWebServiceKey;
  const from = getCoords(fromPoi);
  const to = getCoords(toPoi);
  const origin = `${from.lng},${from.lat}`;
  const destination = `${to.lng},${to.lat}`;

  const url = `https://restapi.amap.com/v3/direction/walking`
    + `?key=${encodeURIComponent(key)}`
    + `&origin=${origin}`
    + `&destination=${destination}`
    + `&output=JSON`
    + `&appname=${config.appName}`;

  try {
    const data = await httpGet(url);

    if (data.status !== '1' || !data.route || !data.route.paths || data.route.paths.length === 0) {
      // API 返回失败，回退到 Haversine 估算
      return fallbackRoute(fromPoi, toPoi, 'API 返回异常');
    }

    const path = data.route.paths[0];
    const distMeters = parseInt(path.distance, 10);
    const durationSec = parseInt(path.duration, 10);

    // NaN 验证：API 返回的数值无效时回退到 Haversine 估算
    if (!Number.isFinite(distMeters) || !Number.isFinite(durationSec)) {
      return fallbackRoute(fromPoi, toPoi, 'API 返回的距离/时长数据无效');
    }

    const walkingMinutes = Math.round(durationSec / 60);

    // 提取路线坐标 [[lng, lat], ...]
    const routeCoords = [];
    if (path.steps) {
      for (const step of path.steps) {
        if (step.polyline) {
          const pairs = step.polyline.split(';');
          for (const pair of pairs) {
            const [lng, lat] = pair.split(',').map(Number);
            if (!isNaN(lng) && !isNaN(lat)) {
              routeCoords.push([lng, lat]);
            }
          }
        }
      }
    }

    return {
      from: fromPoi.name,
      to: toPoi.name,
      walking_minutes: walkingMinutes,
      walking_meters: distMeters,
      route_coords: routeCoords,
    };
  } catch (err) {
    // 网络异常或其他错误，回退到 Haversine 估算
    return fallbackRoute(fromPoi, toPoi, err.message);
  }
}

/**
 * 回退路线 - API 不可用时使用 Haversine 距离估算
 */
function fallbackRoute(fromPoi, toPoi, reason) {
  const from = getCoords(fromPoi);
  const to = getCoords(toPoi);
  const dist = haversine(from.lat, from.lng, to.lat, to.lng);
  // 乘以 1.3 绕路系数估算实际步行距离
  const estMeters = Math.round(dist * 1.3);
  const estMinutes = Math.round(estMeters / 80); // 按正常步行速度 80m/min

  return {
    from: fromPoi.name,
    to: toPoi.name,
    walking_minutes: estMinutes,
    walking_meters: estMeters,
    route_coords: [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ],
    _fallback: true,
    _fallback_reason: reason || '未知原因',
  };
}

// ========================== 用餐站点插入 ==========================

/**
 * 在路线中智能插入用餐站点
 * 
 * 根据用户的 food_preferences 和游览时间线，在午餐/晚餐时段自动插入附近餐厅
 *
 * @param {object[]} orderedPois - 已排序的景点列表
 * @param {object[]} segments - 路段列表
 * @param {object} preferences - 用户偏好（含 food_preferences）
 * @param {object[]} allPois - 全部可用 POI（含未选中的餐饮 POI）
 * @returns {{ orderedPois: object[], segments: object[] }} 插入用餐后的路线
 */
function insertMealStops(orderedPois, segments, preferences, allPois) {
  const foodPrefs = preferences.food_preferences;
  if (!foodPrefs || !foodPrefs.want_food) return { orderedPois, segments };

  // 分离出食物类 POI（未被选入路线的）
  const usedNames = new Set(orderedPois.map(p => p.name));
  const foodCandidates = (allPois || []).filter(p => {
    const cat = p._category || categorizePoiByType(p.type);
    return (cat === 'food' || cat === 'drink') && !usedNames.has(p.name);
  });

  if (foodCandidates.length === 0) return { orderedPois, segments };

  // 用餐时间窗口定义（分钟，从0点开始）
  const mealWindows = {
    breakfast: { start: 7 * 60, end: 9 * 60, duration: 30 },
    lunch:     { start: 11 * 60 + 30, end: 13 * 60, duration: 45 },
    dinner:    { start: 17 * 60 + 30, end: 19 * 60, duration: 60 },
    snack:     { start: 14 * 60, end: 16 * 60, duration: 20 },
  };

  // 假设默认出发时间 9:00
  const startTime = 9 * 60;
  let currentTime = startTime;

  // 计算每个景点的到达/离开时间
  const schedule = orderedPois.map((poi, i) => {
    const arrival = currentTime;
    const visitDuration = poi.suggested_duration_minutes || poi.suggested_duration || 30;
    currentTime += visitDuration;
    const walkTime = (i < segments.length) ? (segments[i].walking_minutes || 10) : 0;
    currentTime += walkTime;
    return { poi, index: i, arrival, departure: currentTime - walkTime };
  });

  // 对每个需要的用餐时段，找到最佳插入点
  const insertions = [];
  for (const mealTime of (foodPrefs.meal_times || [])) {
    const window = mealWindows[mealTime];
    if (!window) continue;

    // 找到时间窗口覆盖的景点间隙
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < schedule.length; i++) {
      const s = schedule[i];
      // 景点的离开时间落在用餐窗口内
      if (s.departure >= window.start - 30 && s.departure <= window.end + 30) {
        const score = 100 - Math.abs(s.departure - (window.start + window.end) / 2);
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      }
    }
    if (bestIdx === -1) continue;

    // 从候选餐厅中选距离最近的
    const refPoi = orderedPois[bestIdx];
    const refLng = refPoi.location?.lng || refPoi.lng || 0;
    const refLat = refPoi.location?.lat || refPoi.lat || 0;

    let bestFood = null;
    let bestDist = Infinity;
    for (const food of foodCandidates) {
      // 菜系匹配筛选
      if (foodPrefs.cuisine_types && foodPrefs.cuisine_types.length > 0) {
        const cuisineMatch = foodPrefs.cuisine_types.some(c =>
          (food._cuisine_type || '').includes(c) || (food.type || '').includes(c)
        );
        if (!cuisineMatch) continue;
      }
      const fLng = food.location?.lng || food.lng || 0;
      const fLat = food.location?.lat || food.lat || 0;
      const dist = haversine(refLat, refLng, fLat, fLng);
      if (dist < bestDist) { bestDist = dist; bestFood = food; }
    }

    // 如果没有匹配菜系的，取最近的任意餐厅
    if (!bestFood && foodCandidates.length > 0) {
      let fallbackDist = Infinity;
      for (const food of foodCandidates) {
        const fLng = food.location?.lng || food.lng || 0;
        const fLat = food.location?.lat || food.lat || 0;
        const dist = haversine(refLat, refLng, fLat, fLng);
        if (dist < fallbackDist) { fallbackDist = dist; bestFood = food; }
      }
    }

    if (bestFood) {
      insertions.push({ afterIndex: bestIdx, foodPoi: bestFood, mealTime, duration: window.duration });
      // 从候选中移除已选的（避免同一餐厅被多次插入）
      const fIdx = foodCandidates.indexOf(bestFood);
      if (fIdx !== -1) foodCandidates.splice(fIdx, 1);
    }
  }

  // 按 afterIndex 从后往前插入，避免索引偏移
  insertions.sort((a, b) => b.afterIndex - a.afterIndex);

  const result = [...orderedPois];
  const resultSegments = [...segments];

  for (const ins of insertions) {
    const insertPos = ins.afterIndex + 1;
    const foodPoi = {
      ...ins.foodPoi,
      _is_meal_stop: true,
      _meal_time: ins.mealTime,
      suggested_duration_minutes: ins.duration,
    };
    result.splice(insertPos, 0, foodPoi);

    // 插入简化路段（无详细步行坐标，用 Haversine 估算）
    if (insertPos < result.length) {
      const prevPoi = result[insertPos - 1];
      const nextPoi = result[insertPos + 1] || result[insertPos];
      const prevLng = prevPoi.location?.lng || prevPoi.lng || 0;
      const prevLat = prevPoi.location?.lat || prevPoi.lat || 0;
      const foodLng = foodPoi.location?.lng || foodPoi.lng || 0;
      const foodLat = foodPoi.location?.lat || foodPoi.lat || 0;

      const distToFood = haversine(prevLat, prevLng, foodLat, foodLng);
      const walkSpeed = preferences.physical_level === 'high' ? 100 :
                         preferences.physical_level === 'low' ? 60 : 80;

      resultSegments.splice(insertPos - 1, 0, {
        from: prevPoi.name,
        to: foodPoi.name,
        walking_minutes: Math.round(distToFood / walkSpeed),
        walking_meters: Math.round(distToFood),
        route_coords: [],
        _is_meal_segment: true,
      });
    }
  }

  return { orderedPois: result, segments: resultSegments };
}

// ========================== 主函数 ==========================

/**
 * 智能路线优化主入口
 *
 * @param {Array}  pois        - 候选景点列表 [{ name, lat, lon, suggested_duration, priority, tags }]
 * @param {Object} preferences - 用户偏好 { duration_hours, pace, interests, physical_level }
 * @param {Object} config      - 可选配置 { amapWebServiceKey }
 * @returns {Object}           - 优化后的路线结果
 */
async function optimizeRoute(pois, preferences, config) {
  // --- 边界情况: 无输入 ---
  if (!pois || pois.length === 0) {
    return {
      ordered_pois: [],
      total_duration_minutes: 0,
      total_walking_minutes: 0,
      total_walking_meters: 0,
      segments: [],
    };
  }

  // 加载或合并配置（空字符串不覆盖已有值）
  const base = loadConfig();
  const override = config || {};
  const cfg = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v !== '' && v !== null && v !== undefined) {
      cfg[k] = v;
    }
  }
  const prefs = { duration_hours: 4, pace: 'medium', interests: [], physical_level: 'medium', ...preferences };

  // ===== 阶段 1: 过滤 =====
  const filtered = filterPois(pois, prefs);

  // 全部被过滤的边界情况
  if (filtered.length === 0) {
    return {
      ordered_pois: [],
      total_duration_minutes: 0,
      total_walking_minutes: 0,
      total_walking_meters: 0,
      segments: [],
      _warning: '所有景点均被过滤，请检查兴趣标签或体力等级设置',
    };
  }

  // ===== 阶段 2: 评分 =====
  const scored = scorePois(filtered, prefs);

  // ===== 阶段 3: 贪心选择 =====
  const selected = selectPois(scored, prefs);

  // 只选中了 1 个景点的边界情况
  if (selected.length === 1) {
    const poi = selected[0];
    const dur = poi._duration || poi.suggested_duration || poi.suggested_duration_minutes || 30;
    return {
      ordered_pois: [cleanPoi(poi)],
      total_duration_minutes: dur,
      total_walking_minutes: 0,
      total_walking_meters: 0,
      segments: [],
    };
  }

  // ===== 阶段 4: 最近邻排序 =====
  let ordered = orderPoisNN(selected);

  // ===== 阶段 5: 2-opt 优化 =====
  ordered = twoOptImprove(ordered);

  // v2: 智能插入用餐站点
  const mealResult = insertMealStops(ordered, [], prefs, pois);
  ordered = mealResult.orderedPois;
  let routeSegments = mealResult.segments;

  // ===== 阶段 6: 调用高德步行 API 生成实际路线 =====
  let segments = [];
  let totalWalkMin = 0;
  let totalWalkM = 0;

  for (let i = 0; i < ordered.length - 1; i++) {
    const seg = await fetchWalkingRoute(ordered[i], ordered[i + 1], cfg);
    segments.push(seg);
    totalWalkMin += seg.walking_minutes;
    totalWalkM   += seg.walking_meters;
  }

  // 计算总游览时长（含步行）
  const totalVisitMin = ordered.reduce((sum, p) => sum + (p._duration || p.suggested_duration || p.suggested_duration_minutes || 30), 0);
  const totalDuration = totalVisitMin + totalWalkMin;

  return {
    ordered_pois: ordered.map(cleanPoi),
    total_duration_minutes: totalDuration,
    total_walking_minutes: totalWalkMin,
    total_walking_meters: totalWalkM,
    segments,
  };
}

/**
 * 清理 POI 对象，移除内部评分字段
 */
function cleanPoi(poi) {
  const { _score, _interestMatch, _durationFit, _duration, _priority, ...clean } = poi;
  return clean;
}

// ========================== CLI 入口 ==========================

/**
 * 命令行用法:
 *   node route-optimizer.js --pois=pois.json --preferences=prefs.json
 *
 * 支持文件路径和内联 JSON 两种方式:
 *   --pois=pois.json              (从文件读取)
 *   --pois='[{"name":"断桥残雪",...}]'  (内联 JSON)
 */
async function main() {
  const args = process.argv.slice(2);
  const params = {};

  for (const arg of args) {
    const match = arg.match(/^--(\w+)=(.+)$/);
    if (match) {
      params[match[1]] = match[2];
    }
  }

  // --- 解析 POIs ---
  let pois;
  if (params.pois) {
    try {
      // 先尝试当文件路径读取
      pois = JSON.parse(fs.readFileSync(params.pois, 'utf8'));
    } catch (_) {
      try {
        // 再尝试内联 JSON
        pois = JSON.parse(params.pois);
      } catch (e) {
        console.error('错误: 无法解析 --pois 参数，请提供有效的 JSON 文件路径或内联 JSON');
        process.exit(1);
      }
    }
  } else {
    console.error('用法: node route-optimizer.js --pois=<file|json> --preferences=<file|json>');
    process.exit(1);
  }

  // --- 解析用户偏好 ---
  let preferences = {};
  if (params.preferences) {
    try {
      preferences = JSON.parse(fs.readFileSync(params.preferences, 'utf8'));
    } catch (_) {
      try {
        preferences = JSON.parse(params.preferences);
      } catch (e) {
        console.error('错误: 无法解析 --preferences 参数');
        process.exit(1);
      }
    }
  }

  // --- 执行优化 ---
  const result = await optimizeRoute(pois, preferences);

  // --- 输出结果 ---
  console.log(JSON.stringify(result, null, 2));
}

// 若直接运行则执行 CLI
if (require.main === module) {
  main().catch((err) => {
    console.error('运行出错:', err.message);
    process.exit(1);
  });
}

// 导出供外部调用
module.exports = { optimizeRoute, haversine, filterPois, scorePois, selectPois, orderPoisNN, twoOptImprove, insertMealStops, categorizePoiByType };
