/**
 * 次元旅人 - 旅行手账生成器 (Node.js)
 *
 * 功能:
 *   1. 读取 travel-journal.html 模板
 *   2. 注入路线规划数据（替换 __JOURNAL_DATA__）
 *   3. 输出可直接在浏览器中打开的手账 HTML 文件
 *
 * CLI 用法:
 *   node journal-generator.js --data=route_result.json --output=travel-journal.html
 *
 * 模块导出:
 *   generateJournal(mapData, outputPath, options)
 */

const fs = require('fs');
const path = require('path');

// ========================================================
// 常量
// ========================================================

const TEMPLATE_PATH = path.resolve(__dirname, '..', 'templates', 'travel-journal.html');

// ========================================================
// 工具函数
// ========================================================

/**
 * 读取手账模板
 * @returns {string} 模板内容
 */
function readTemplate() {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`手账模板不存在: ${TEMPLATE_PATH}`);
  }
  return fs.readFileSync(TEMPLATE_PATH, 'utf-8');
}

/**
 * 安全地序列化 JSON，转义 </script> 标签
 * @param {Object} data
 * @returns {string}
 */
function safeStringify(data) {
  return JSON.stringify(data, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/-->/g, '\\u002d\\u002d\\u003e');
}

// ========================================================
// 核心功能
// ========================================================

/**
 * 生成旅行手账 HTML 文件
 *
 * @param {Object} mapData - 地图数据（与 index.html 中 window.__CURRENT_MAP_DATA__ 结构一致）
 *   {
 *     pois: Array,            // POI 列表
 *     segments: Array,        // 路段数据
 *     narrations: Array,      // 语音导览文案
 *     city: string,           // 城市名
 *     scenic_name: string,    // 景区名
 *     city_welcome: string,   // 城市欢迎语
 *     food_summary: string,   // 美食摘要
 *     total_duration_min: number,
 *     total_walking_min: number,
 *     scenic_count: number,
 *     food_count: number,
 *   }
 * @param {string} outputPath - 输出文件路径
 * @param {Object} [options] - 可选配置
 * @param {string} [options.date] - 日期文本
 * @returns {string} 生成的文件绝对路径
 */
function generateJournal(mapData, outputPath, options) {
  if (!mapData || typeof mapData !== 'object') {
    throw new Error('mapData 参数无效');
  }
  if (!outputPath) {
    throw new Error('outputPath 参数无效');
  }

  const opts = options || {};
  const html = readTemplate();

  // 构建注入数据
  const journalData = {
    pois: mapData.pois || [],
    segments: mapData.segments || [],
    narrations: mapData.narrations || [],
    city: mapData.city || '',
    scenic_name: mapData.scenic_name || '',
    city_welcome: mapData.city_welcome || '',
    food_summary: mapData.food_summary || '',
    total_duration_min: mapData.total_duration_min || 0,
    total_walking_min: mapData.total_walking_min || 0,
    date: opts.date || new Date().toLocaleDateString('zh-CN'),
  };

  // 替换数据占位符
  const dataJson = safeStringify(journalData);
  const result = html.replace(/var __JOURNAL_DATA__ = \{\};/, 'var __JOURNAL_DATA__ = ' + dataJson + ';');

  // 确保输出目录存在
  const outputDir = path.dirname(path.resolve(outputPath));
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const absoluteOutput = path.resolve(outputPath);
  fs.writeFileSync(absoluteOutput, result, 'utf-8');
  console.log('[手账生成器] 已生成:', absoluteOutput);
  return absoluteOutput;
}

// ========================================================
// CLI 入口
// ========================================================

if (require.main === module) {
  const args = process.argv.slice(2);

  function getArg(name) {
    const prefix = '--' + name + '=';
    const arg = args.find(a => a.startsWith(prefix));
    return arg ? arg.slice(prefix.length) : null;
  }

  const dataFile = getArg('data');
  const outputFile = getArg('output') || 'travel-journal-output.html';

  if (!dataFile) {
    console.error('用法: node journal-generator.js --data=<json文件> [--output=<输出文件>]');
    process.exit(1);
  }

  const dataPath = path.resolve(dataFile);
  if (!fs.existsSync(dataPath)) {
    console.error('数据文件不存在:', dataPath);
    process.exit(1);
  }

  const mapData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  generateJournal(mapData, outputFile);
}

// ========================================================
// 模块导出
// ========================================================

module.exports = { generateJournal };
