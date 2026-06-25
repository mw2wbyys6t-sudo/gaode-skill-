/**
 * 次元旅人 - 美食数据提供者抽象层
 *
 * 架构：
 *   FoodDataProvider (抽象基类)
 *   ├── LLMFoodEnricher       ← 默认实现，用 LLM 增强美食 POI（始终可用）
 *   └── AggregatorProvider     ← 预留实现，第三方聚合 API（未来接入）
 *
 * 功能：
 *   1. enrichFoodPois() — 为已有高德 POI 追加招牌菜、口碑、用餐建议等深度信息
 *   2. getCityMustEatList() — 生成城市必吃美食清单（独立于高德 POI）
 *
 * 用法：
 *   const { createFoodProvider } = require('./food-data-provider');
 *   const provider = createFoodProvider(config);
 *   const enriched = await provider.enrichFoodPois('杭州', foodPois, config);
 */

'use strict';

const axios = require('axios');

// ============================================================
// 抽象基类
// ============================================================

class FoodDataProvider {
  /**
   * 增强美食 POI 列表的附加信息
   * @param {string} city 城市名
   * @param {Array} foodPois 高德返回的美食 POI 列表
   * @param {Object} config 全局配置
   * @returns {Promise<Array>} 增强后的 POI 列表（每个 POI 含 _signature_dishes, _review_summary, _best_time, _food_culture）
   */
  async enrichFoodPois(city, foodPois, config) {
    throw new Error('Not implemented');
  }

  /**
   * 生成城市必吃清单
   * @param {string} city 城市名
   * @param {Object} config 全局配置
   * @returns {Promise<Object>} { must_eat_dishes, must_eat_streets, food_culture_intro }
   */
  async getCityMustEatList(city, config) {
    throw new Error('Not implemented');
  }
}

// ============================================================
// LLM 增强实现（默认，始终可用）
// ============================================================

class LLMFoodEnricher extends FoodDataProvider {

  /**
   * 提取 LLM 配置（兼容多种字段命名）
   */
  _getLLMConfig(config) {
    return {
      apiKey:   config.llmApiKey || config.llm_api_key || config.apiKey || '',
      endpoint: config.llmEndpoint || config.llm_endpoint || config.endpoint || 'https://api.deepseek.com/v1/chat/completions',
      model:    config.llmModel || config.llm_model || config.model || 'deepseek-chat',
    };
  }

  /**
   * 安全地解析 LLM 返回的 JSON（容错处理）
   */
  _parseJSON(text) {
    if (!text) return null;
    // 去除 markdown 代码块包裹
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```$/i, '');
    cleaned = cleaned.trim();
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      // 尝试提取第一个 [ 或 { 到最后一个 ] 或 }
      const arrStart = cleaned.indexOf('[');
      const arrEnd = cleaned.lastIndexOf(']');
      if (arrStart >= 0 && arrEnd > arrStart) {
        try { return JSON.parse(cleaned.substring(arrStart, arrEnd + 1)); } catch (_) {}
      }
      const objStart = cleaned.indexOf('{');
      const objEnd = cleaned.lastIndexOf('}');
      if (objStart >= 0 && objEnd > objStart) {
        try { return JSON.parse(cleaned.substring(objStart, objEnd + 1)); } catch (_) {}
      }
      console.warn('   ⚠ LLM JSON 解析失败:', e.message);
      return null;
    }
  }

  /**
   * 增强美食 POI：批量调用 LLM 为每个餐厅生成招牌菜、口碑、用餐建议
   */
  async enrichFoodPois(city, foodPois, config) {
    if (!foodPois || foodPois.length === 0) return [];

    const { apiKey, endpoint, model } = this._getLLMConfig(config);
    if (!apiKey) {
      console.warn('   ⚠ 未配置 LLM API Key，跳过美食增强');
      return foodPois;
    }

    // 取最多 8 个 POI（避免 token 过长导致 JSON 截断）
    const batch = foodPois.slice(0, 8);
    const restaurantList = batch.map((p, i) => {
      const cuisine = p._cuisine_type || '';
      const cost = p._avg_cost ? `，人均${p._avg_cost}元` : '';
      return `${i + 1}. ${p.name}${cuisine ? '(' + cuisine + ')' : ''}${cost}`;
    }).join('\n');

    const systemPrompt = `你是一个中国美食专家，熟悉全国各地的特色餐厅和饮食文化。
请为以下餐厅生成增强信息，以 JSON 数组返回。每个元素包含：
- name: 餐厅名（必须与输入完全匹配）
- signature_dishes: 招牌菜推荐（数组，最多3道，每道包含 name 和 desc 字段）
- review_summary: 食客口碑摘要（1-2句话，模拟真实食客视角，口语化）
- best_time: 最佳用餐时段建议（如"午餐11:30前到避免排队"）
- food_culture: 与该餐厅或菜品相关的本地饮食文化小知识（1句话）
只返回 JSON 数组，不要输出其他文字。`;

    const userPrompt = `城市：${city}\n餐厅列表：\n${restaurantList}`;

    try {
      const resp = await axios.post(endpoint, {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.6,
        max_tokens: 3000,
      }, {
        timeout: 30000,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      });

      const text = resp.data?.choices?.[0]?.message?.content?.trim() || '';
      const parsed = this._parseJSON(text);

      if (!Array.isArray(parsed)) {
        console.warn('   ⚠ LLM 美食增强返回非数组格式');
        return foodPois;
      }

      // 按 name 匹配回原 POI，追加增强字段
      let enrichedCount = 0;
      parsed.forEach(item => {
        if (!item.name) return;
        // 模糊匹配：包含关系即可（LLM 可能微调名称）
        const match = foodPois.find(p =>
          p.name === item.name ||
          p.name.includes(item.name) ||
          item.name.includes(p.name)
        );
        if (match) {
          match._signature_dishes = Array.isArray(item.signature_dishes)
            ? item.signature_dishes.slice(0, 3).map(d =>
                typeof d === 'string' ? { name: d, desc: '' } : { name: d.name || '', desc: d.desc || '' }
              )
            : [];
          match._review_summary = item.review_summary || '';
          match._best_time = item.best_time || '';
          match._food_culture = item.food_culture || '';
          enrichedCount++;
        }
      });

      console.log(`   ✔ 美食增强完成: ${enrichedCount}/${batch.length} 个餐厅`);
      return foodPois;
    } catch (err) {
      console.warn(`   ⚠ 美食增强 LLM 调用失败（不影响主流程）: ${err.message}`);
      return foodPois;
    }
  }

  /**
   * 生成城市必吃美食清单
   */
  async getCityMustEatList(city, config) {
    if (!city) return null;

    const { apiKey, endpoint, model } = this._getLLMConfig(config);
    if (!apiKey) return null;

    const systemPrompt = `你是一个中国旅游美食达人，熟悉各地特色饮食。请为以下城市推荐必吃美食清单。
输出 JSON 格式：
{
  "must_eat_dishes": [
    {"name": "菜名", "desc": "一句话简介", "where": "推荐去哪吃（餐厅名或区域）"}
  ],
  "must_eat_streets": ["美食街或美食区域名称"],
  "food_culture_intro": "一句话介绍该城市的饮食文化特色"
}
must_eat_dishes 最多 8 道，must_eat_streets 最多 5 条。
只返回 JSON，不要输出其他文字。`;

    try {
      const resp = await axios.post(endpoint, {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `城市：${city}` },
        ],
        temperature: 0.5,
        max_tokens: 800,
      }, {
        timeout: 15000,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      });

      const text = resp.data?.choices?.[0]?.message?.content?.trim() || '';
      const parsed = this._parseJSON(text);

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        console.log(`   ✔ 必吃清单已生成: ${(parsed.must_eat_dishes || []).length} 道菜, ${(parsed.must_eat_streets || []).length} 条街`);
        return {
          must_eat_dishes: Array.isArray(parsed.must_eat_dishes) ? parsed.must_eat_dishes.slice(0, 8) : [],
          must_eat_streets: Array.isArray(parsed.must_eat_streets) ? parsed.must_eat_streets.slice(0, 5) : [],
          food_culture_intro: parsed.food_culture_intro || '',
        };
      }

      console.warn('   ⚠ 必吃清单返回格式异常');
      return null;
    } catch (err) {
      console.warn(`   ⚠ 必吃清单 LLM 调用失败（不影响主流程）: ${err.message}`);
      return null;
    }
  }
}

// ============================================================
// 第三方聚合 API 预留实现
// ============================================================

class AggregatorProvider extends FoodDataProvider {
  /**
   * @param {Object} apiConfig
   * @param {string} apiConfig.food_api_key     第三方 API Key
   * @param {string} apiConfig.food_api_endpoint 第三方 API 端点
   */
  constructor(apiConfig) {
    super();
    this.apiKey = (apiConfig && apiConfig.food_api_key) || '';
    this.endpoint = (apiConfig && apiConfig.food_api_endpoint) || '';
    this._fallback = new LLMFoodEnricher();
  }

  async enrichFoodPois(city, foodPois, config) {
    if (!this.apiKey || !this.endpoint) {
      // 未配置第三方 API，回退到 LLM 增强
      return this._fallback.enrichFoodPois(city, foodPois, config);
    }

    // TODO: 实现第三方 API 调用
    // 示例（聚合数据平台）：
    //   const resp = await axios.get(this.endpoint + '/food/search', {
    //     params: { key: this.apiKey, city, keyword: poi.name },
    //   });
    //   // 合并评分、评论数、热门菜品等字段
    // 目前回退到 LLM
    console.log('   ℹ AggregatorProvider 尚未实现，回退到 LLM 增强');
    return this._fallback.enrichFoodPois(city, foodPois, config);
  }

  async getCityMustEatList(city, config) {
    // 必吃清单始终使用 LLM（第三方 API 通常不提供此类功能）
    return this._fallback.getCityMustEatList(city, config);
  }
}

// ============================================================
// 工厂函数
// ============================================================

/**
 * 根据配置创建美食数据提供者
 *
 * @param {Object} config 全局配置（可含 food_provider 段）
 * @returns {FoodDataProvider}
 *
 * config.food_provider 示例：
 * {
 *   "type": "llm",           // "llm"（默认）或 "aggregator"
 *   "food_api_key": "",      // 第三方 API Key（aggregator 模式）
 *   "food_api_endpoint": ""  // 第三方 API 端点（aggregator 模式）
 * }
 */
function createFoodProvider(config) {
  const providerConfig = (config && config.food_provider) || {};
  const providerType = providerConfig.type || 'llm';

  switch (providerType) {
    case 'aggregator':
      return new AggregatorProvider(providerConfig);
    case 'llm':
    default:
      return new LLMFoodEnricher();
  }
}

// ============================================================
// 模块导出
// ============================================================

module.exports = {
  createFoodProvider,
  FoodDataProvider,
  LLMFoodEnricher,
  AggregatorProvider,
};
