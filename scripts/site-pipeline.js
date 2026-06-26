/**
 * 餐饮选址通 - 智能选址全流程管线（Node.js 入口）
 *
 * 将五个阶段串联为端到端选址分析流水线：
 *   阶段 1：选址意图解析    → site-intent-parser.js  → parseSiteIntent()
 *   阶段 2：竞争扫描         → competition-scanner.js → scanCompetition()
 *   阶段 3：商圈画像         → area-profiler.js       → profileArea()
 *   阶段 4：选址评分 & 对比  → site-analyzer.js       → scoreSite() + compareSites()
 *   阶段 5：报告生成         → templates/site-report.html → generateSiteReport()
 *
 * CLI 用法：
 *   node site-pipeline.js --input="在成都春熙路开火锅店，月租2万以内"
 *   node site-pipeline.js --input="在长沙五一广场开湘菜馆" --output=site-report.html --open
 *
 * 可选参数：
 *   --input   用户自然语言输入（必填）
 *   --city    城市名称（可选，可从意图中推断）
 *   --output  输出 HTML 文件路径（默认 site-report.html）
 *   --open    完成后自动在浏览器中打开
 *
 * 模块导出：
 *   runSitePipeline(userInput, options)
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { exec } = require('child_process');

// ---------- 导入选址子模块 ----------
const { parseSiteIntent }      = require('./site-intent-parser');
const { scanCompetition }      = require('./competition-scanner');
const { profileArea }          = require('./area-profiler');
const { scoreSite, compareSites } = require('./site-analyzer');
const {
  geocodeAddress,
  resolveApiKey,
} = require('./scenic-data-fetcher');
const { generateSiteReportDocx } = require('./site-report-docx');

// ---------- 配置加载 ----------

/** 请求阶段间延迟（毫秒），避免高德 QPS 限流 */
const STAGE_DELAY = 500;

/** 延迟指定毫秒数 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadSharedConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch (err) {
    console.warn('[选址管线] 读取 config.json 失败:', err.message);
  }
  return {};
}

// ---------- LLM 综合建议生成 ----------

/**
 * 调用 LLM 生成综合选址建议
 * @param {Array} siteScores - 各区域评分结果数组
 * @param {Object} siteIntent - 选址意图
 * @param {Object} config - LLM 配置
 * @returns {Promise<string>} 综合建议文本
 */
async function generateRecommendation(siteScores, siteIntent, config) {
  let _axios;
  try { _axios = require('axios'); } catch (_) { return ''; }

  const llmConfig = {
    endpoint: config.llmEndpoint || config.endpoint || 'https://api.deepseek.com/v1/chat/completions',
    apiKey: config.llmApiKey || config.apiKey || '',
    model: config.llmModel || config.model || 'deepseek-chat',
  };

  if (!llmConfig.apiKey) return '';

  const summaryData = siteScores.map(s => ({
    区域: s.area_name,
    总分: s.total,
    评级: s.grade,
    建议: s.recommendation,
    战略分: s.breakdown.strategic,
    竞争分: s.breakdown.competition,
    销售分: s.breakdown.sales,
    配套分: s.breakdown.service,
    立地分: s.breakdown.conditions,
  }));

  try {
    const response = await _axios.post(llmConfig.endpoint, {
      model: llmConfig.model,
      messages: [
        {
          role: 'system',
          content: `你是一位有10年经验的餐饮选址顾问。请根据以下选址评分数据，为用户生成200字以内的综合建议。
包含：
1. 推荐首选区域及理由
2. 各区域的优劣势简要对比
3. 风险提示（如有）
4. 下一步实地考察建议（推荐考察时段、重点观察指标）
用口语化风格，像朋友给建议一样自然。只输出建议文本，不要JSON。`
        },
        {
          role: 'user',
          content: `我想${siteIntent.city ? '在' + siteIntent.city : ''}开一家${siteIntent.restaurant_type || '餐饮'}店${siteIntent.budget_rent ? '，月租预算' + siteIntent.budget_rent + '元' : ''}。

选址评分结果：
${JSON.stringify(summaryData, null, 2)}`
        },
      ],
      temperature: 0.6,
      max_tokens: 800,
    }, {
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmConfig.apiKey}`,
      },
    });

    const text = response.data?.choices?.[0]?.message?.content?.trim();
    if (text) {
      console.log('[选址管线] LLM 综合建议生成完成');
      return text;
    }
  } catch (err) {
    console.warn(`[选址管线] LLM 综合建议生成失败: ${err.message}`);
  }
  return '';
}

// ---------- 报告生成 ----------

/** 报告模板路径 */
const REPORT_TEMPLATE_PATH = path.resolve(__dirname, '..', 'templates', 'site-report.html');

/**
 * 生成选址分析报告 HTML
 * @param {Object} reportData - 完整报告数据
 * @param {string} outputPath - 输出文件路径
 * @param {Object} config - 含 amapJsapiKey、amapSecurityJsCode
 * @returns {string} 输出文件的绝对路径
 */
function generateSiteReport(reportData, outputPath, config = {}) {
  const absOutput = path.resolve(outputPath);

  // 读取模板
  let template;
  try {
    template = fs.readFileSync(REPORT_TEMPLATE_PATH, 'utf-8');
  } catch (err) {
    // 模板不存在时，生成简化报告
    console.warn(`[选址管线] 模板文件不存在 (${REPORT_TEMPLATE_PATH})，生成 JSON 报告`);
    const jsonOutput = absOutput.replace(/\.html$/, '.json');
    fs.writeFileSync(jsonOutput, JSON.stringify(reportData, null, 2), 'utf-8');
    console.log(`[选址管线] JSON 报告已保存至: ${jsonOutput}`);
    return jsonOutput;
  }

  // 替换占位符
  const amapKey = config.amapJsapiKey || '';
  const securityCode = config.amapSecurityJsCode || '';

  let html = template;
  html = html.replace(/__SITE_DATA__/g, JSON.stringify(reportData));
  html = html.replace(/__AMAP_KEY__/g, amapKey);
  html = html.replace(/__SECURITY_CODE__/g, securityCode);

  fs.writeFileSync(absOutput, html, 'utf-8');
  console.log(`[选址管线] 分析报告已保存至: ${absOutput}`);
  return absOutput;
}

// ---------- 主流水线 ----------

/**
 * 执行选址分析全流程
 *
 * @param {string} userInput - 用户自然语言输入
 * @param {Object} [options] - 可选配置
 * @param {string} [options.city] - 城市名称覆盖
 * @param {string} [options.output] - 输出文件路径
 * @param {boolean} [options.open] - 是否自动打开浏览器
 * @returns {Promise<Object>} 完整分析结果
 */
async function runSitePipeline(userInput, options = {}) {
  console.log('═══════════════════════════════════════════');
  console.log('  餐饮选址通 · 智能选址分析');
  console.log('═══════════════════════════════════════════');
  console.log(`  输入: ${userInput}\n`);

  const sharedConfig = loadSharedConfig();
  const amapKey = resolveApiKey(options) || sharedConfig.amapWebServiceKey || '';

  if (!amapKey) {
    throw new Error('未找到高德 API Key，请在 config.json 中配置 amapWebServiceKey');
  }

  // ======== 阶段 1：选址意图解析 ========
  console.log('[阶段 1/5] 解析选址意图...');
  const siteIntent = await parseSiteIntent(userInput, sharedConfig);

  // 允许外部覆盖城市
  if (options.city && !siteIntent.city) {
    siteIntent.city = options.city;
  }

  if (!siteIntent.restaurant_type) {
    console.warn('[选址管线] 未能识别餐饮类型，默认使用"中餐"');
    siteIntent.restaurant_type = '中餐';
  }

  // 如果没有指定候选区域，用城市名作为默认
  if (siteIntent.target_areas.length === 0) {
    if (siteIntent.city) {
      siteIntent.target_areas = [siteIntent.city + '市中心'];
      console.log(`[选址管线] 未指定商圈，默认使用: ${siteIntent.target_areas[0]}`);
    } else {
      throw new Error('未能识别目标城市或商圈，请在输入中指定');
    }
  }

  console.log(`  餐饮类型: ${siteIntent.restaurant_type}`);
  console.log(`  目标城市: ${siteIntent.city || '(未指定)'}`);
  console.log(`  候选区域: ${siteIntent.target_areas.join(', ')}`);
  console.log(`  月租预算: ${siteIntent.budget_rent ? siteIntent.budget_rent + '元' : '(未指定)'}`);
  console.log(`  店铺类型: ${siteIntent.store_type}`);

  // ======== 阶段 2：竞争扫描 ========
  console.log('\n[阶段 2/5] 多半径竞争扫描...');

  const areaResults = [];

  for (let areaIdx = 0; areaIdx < siteIntent.target_areas.length; areaIdx++) {
    const areaName = siteIntent.target_areas[areaIdx];
    console.log(`\n── 扫描区域: ${areaName} ──`);

    // 多区域间延迟（非第一个区域时）
    if (areaIdx > 0) {
      await sleep(STAGE_DELAY);
    }

    // 地理编码获取坐标
    const geoResult = await geocodeAddress(
      siteIntent.city ? `${siteIntent.city}${areaName}` : areaName,
      siteIntent.city || '',
      amapKey,
    );

    if (!geoResult || !geoResult.lng || !geoResult.lat) {
      console.warn(`[选址管线] 地理编码失败: ${areaName}，跳过该区域`);
      continue;
    }

    const { lng, lat } = geoResult;
    console.log(`[选址管线] ${areaName} 坐标: (${lng.toFixed(4)}, ${lat.toFixed(4)})`);

    // 地理编码后稍等片刻再发起竞争扫描
    await sleep(STAGE_DELAY);

    // 竞争扫描
    const competition = await scanCompetition(lng, lat, amapKey, {
      city: siteIntent.city,
      areaName: areaName,
      pageSize: 25,
    });

    // 竞争扫描完成后稍等再启动商圈画像
    await sleep(STAGE_DELAY);

    // ======== 阶段 3：商圈画像 ========
    console.log(`\n[阶段 3/5] 商圈画像: ${areaName}...`);
    const profile = await profileArea(lng, lat, amapKey, {
      city: siteIntent.city,
      areaName: areaName,
    });

    areaResults.push({
      area_name: areaName,
      center: { lng, lat },
      competition,
      profile,
    });
  }

  if (areaResults.length === 0) {
    throw new Error('所有候选区域均无法获取坐标数据，请检查输入');
  }

  // ======== 阶段 4：选址评分 ========
  console.log('\n[阶段 4/5] 选址评分...');

  const siteScores = areaResults.map(area => {
    const score = scoreSite(
      { competition: area.competition, profile: area.profile },
      siteIntent,
    );
    score.area_name = area.area_name;
    score.center = area.center;
    console.log(`  ${area.area_name}: ${score.total}分 (${score.grade}) - ${score.recommendation}`);
    return score;
  });

  // 多区域对比
  let comparison = null;
  if (siteScores.length > 1) {
    comparison = compareSites(siteScores);
    console.log(`\n  推荐首选: ${comparison.best.area_name} (${comparison.best.total}分)`);
  }

  // LLM 综合建议
  console.log('\n[阶段 5/5] 生成综合建议与报告...');
  const recommendation = await generateRecommendation(siteScores, siteIntent, sharedConfig);
  if (recommendation) {
    console.log(`\n  综合建议: ${recommendation.slice(0, 80)}...`);
  }

  // ======== 阶段 5：报告生成 ========
  const reportData = {
    intent: siteIntent,
    areas: areaResults.map((area, i) => ({
      ...area,
      score: siteScores[i],
    })),
    scores: siteScores,
    comparison,
    recommendation,
    generated_at: new Date().toISOString(),
  };

  const outputPath = options.output
    || path.resolve(__dirname, '..', 'output', 'site-report.html');

  // 确保输出目录存在
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const reportPath = generateSiteReport(reportData, outputPath, sharedConfig);

  // Word 报告（与 HTML 并行输出）
  let docxPath = null;
  try {
    docxPath = outputPath.replace(/\.html$/, '.docx');
    await generateSiteReportDocx(reportData, docxPath);
    console.log(`[选址管线] Word 报告已保存至: ${docxPath}`);
  } catch (docxErr) {
    console.warn(`[选址管线] Word 报告生成失败（HTML 报告不受影响）: ${docxErr.message}`);
    docxPath = null;
  }

  // 自动打开
  if (options.open) {
    console.log('[选址管线] 正在打开浏览器...');
    try {
      exec(`start "" "${reportPath}"`);  // Windows
    } catch (_) {
      try { exec(`open "${reportPath}"`); } catch (__) { /* macOS fallback */ }
    }
  }

  // ======== 输出摘要 ========
  console.log('\n═══════════════════════════════════════════');
  console.log('  选址分析完成！');
  console.log('═══════════════════════════════════════════');
  for (const score of siteScores) {
    console.log(`  📍 ${score.area_name}: ${score.total}分 (${score.grade})`);
  }
  if (comparison) {
    console.log(`  🏆 推荐首选: ${comparison.best.area_name}`);
  }
  console.log(`  📄 HTML 报告: ${reportPath}`);
  if (docxPath) {
    console.log(`  📄 Word 报告: ${docxPath}`);
  }
  console.log('═══════════════════════════════════════════\n');

  return {
    success: true,
    ...reportData,
    output_file: reportPath,
    docx_file: docxPath,
  };
}

// ---------- CLI 入口 ----------

if (require.main === module) {
  const args = process.argv.slice(2).reduce((acc, arg) => {
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (match) {
      acc[match[1]] = match[2] !== undefined ? match[2] : true;
    }
    return acc;
  }, {});

  const input = args.input;
  if (!input) {
    console.error('用法: node site-pipeline.js --input="在成都春熙路开火锅店，月租2万以内"');
    console.error('');
    console.error('可选参数:');
    console.error('  --city=城市名      覆盖意图解析的城市');
    console.error('  --output=路径      输出 HTML 文件路径');
    console.error('  --open             完成后自动打开浏览器');
    process.exit(1);
  }

  runSitePipeline(input, {
    city: args.city,
    output: args.output,
    open: args.open === true || args.open === 'true',
  })
    .then(result => {
      if (!args.output) {
        // CLI 模式打印 JSON 摘要
        console.log('\nJSON 摘要:');
        console.log(JSON.stringify({
          intent: result.intent,
          scores: result.scores.map(s => ({
            area: s.area_name,
            total: s.total,
            grade: s.grade,
            breakdown: s.breakdown,
          })),
          comparison: result.comparison,
          recommendation: result.recommendation,
        }, null, 2));
      }
    })
    .catch(err => {
      console.error(`\n❌ 选址分析失败: ${err.message}`);
      if (process.env.DEBUG) console.error(err.stack);
      process.exit(1);
    });
}

// ---------- 模块导出 ----------

module.exports = {
  runSitePipeline,
  generateSiteReport,
  generateSiteReportDocx,
  generateRecommendation,
};
