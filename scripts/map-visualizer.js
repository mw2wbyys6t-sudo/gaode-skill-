/**
 * 次元旅人 - 地图可视化生成器 (Node.js)
 *
 * 功能:
 *   1. 读取 interactive-map.html 模板
 *   2. 替换 __MAP_DATA__ 和 __AMAP_KEY__ 占位符
 *   3. 输出可直接在浏览器中打开的交互式地图 HTML 文件
 *
 * CLI 用法:
 *   node map-visualizer.js --data=route_result.json --output=tour-map.html
 *
 * 模块导出:
 *   generateMap(routeResult, outputPath, config)
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ========================================================
// 常量与默认配置
// ========================================================

/** 模板文件路径（相对于本脚本） */
const TEMPLATE_PATH = path.resolve(__dirname, '..', 'templates', 'interactive-map.html');

/** 默认测试用 JSAPI Key（仅供开发调试，生产环境请替换） */
const DEFAULT_AMAP_KEY = 'YOUR_AMAP_JSAPI_KEY';

/** 配置文件路径 */
const CONFIG_PATH = path.resolve(__dirname, '..', 'config.json');

// ========================================================
// 工具函数
// ========================================================

/**
 * 加载高德 JSAPI Key
 * 优先级: config 参数 > 环境变量 AMAP_JSAPI_KEY > config.json > 默认测试 Key
 *
 * @param {Object} [config] - 外部传入的配置对象
 * @param {string} [config.amapJsapiKey] - JSAPI Key
 * @returns {string} JSAPI Key
 */
function resolveAmapKey(config) {
  // 1. 外部直接传入
  if (config && config.amapJsapiKey) {
    return config.amapJsapiKey;
  }

  // 2. 环境变量
  if (process.env.AMAP_JSAPI_KEY) {
    return process.env.AMAP_JSAPI_KEY;
  }

  // 3. 配置文件
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (fileConfig.amapJsapiKey) {
        return fileConfig.amapJsapiKey;
      }
    }
  } catch (err) {
    console.warn('[次元旅人] 读取 config.json 失败:', err.message);
  }

  // 4. 兜底默认值
  return DEFAULT_AMAP_KEY;
}

/**
 * 读取 HTML 模板
 *
 * @returns {string} 模板内容
 */
function readTemplate() {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`模板文件不存在: ${TEMPLATE_PATH}`);
  }
  return fs.readFileSync(TEMPLATE_PATH, 'utf-8');
}

// ========================================================
// 核心功能
// ========================================================

/**
 * 生成地图 HTML 文件
 *
 * @param {Object} routeResult - 路线规划结果数据，结构如下:
 *   {
 *     scenic_name: string,          // 景区名称
 *     pois: Array<{                 // POI 列表
 *       name: string,               // 景点名称
 *       lng: number,                // 经度
 *       lat: number,                // 纬度
 *       index: number,              // 序号（从 1 开始）
 *       duration_min: number,       // 建议游览时长（分钟）
 *       tags: string[],             // 标签
 *       address: string             // 地址
 *     }>,
 *     segments: Array<{             // 步行路段
 *       from_index: number,         // 起点 POI 索引（0-based）
 *       to_index: number,           // 终点 POI 索引（0-based）
 *       coords: number[][],         // 路线坐标 [[lng, lat], ...]
 *       walking_min: number         // 步行时间（分钟）
 *     }>,
 *     total_duration_min: number,   // 总游览时长（分钟）
 *     total_walking_min: number     // 总步行时长（分钟）
 *   }
 * @param {string} outputPath - 输出 HTML 文件路径
 * @param {Object} [config] - 可选配置
 * @param {string} [config.amapJsapiKey] - 高德 JSAPI Key
 * @returns {string} 生成的文件绝对路径
 */
function generateMap(routeResult, outputPath, config) {
  // 参数校验
  if (!routeResult || typeof routeResult !== 'object') {
    throw new Error('routeResult 参数无效，请传入路线规划结果对象');
  }
  if (!outputPath) {
    throw new Error('outputPath 参数无效，请指定输出文件路径');
  }

  // 解析 JSAPI Key
  const amapKey = resolveAmapKey(config);

  // 读取模板
  let html = readTemplate();

  // 替换数据占位符 —— 将 MAP_DATA 替换为 JSON 字符串（全局替换，因为模板中可能出现多次）
  // v2 fix: 转义 `<` 为 `\u003c`，防止 POI 数据中的 `</script>` 标签提前关闭 script 块
  const dataJson = JSON.stringify(routeResult, null, 2).replace(/</g, '\\u003c');
  html = html.replace(/__MAP_DATA__/g, dataJson);

  // 替换 JSAPI Key 占位符（全局替换）
  html = html.replace(/__AMAP_KEY__/g, amapKey);

  // 替换安全密钥占位符
  const securityCode = (config && config.amapSecurityJsCode)
    || process.env.AMAP_SECURITY_CODE
    || (function() {
        try {
          const fc = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
          return fc.amapSecurityJsCode || '';
        } catch(_) { return ''; }
      })()
    || '';
  html = html.replace(/__SECURITY_CODE__/g, securityCode);

  // 确保输出目录存在
  const outputDir = path.dirname(path.resolve(outputPath));
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 写入文件
  const absoluteOutput = path.resolve(outputPath);
  fs.writeFileSync(absoluteOutput, html, 'utf-8');

  console.log(`[次元旅人] 地图 HTML 已生成: ${absoluteOutput}`);
  return absoluteOutput;
}

/**
 * 在默认浏览器中打开生成的 HTML 文件
 *
 * @param {string} filePath - HTML 文件路径
 */
function openInBrowser(filePath) {
  const absolutePath = path.resolve(filePath);
  const platform = process.platform;

  let command;
  if (platform === 'darwin') {
    command = `open "${absolutePath}"`;
  } else if (platform === 'win32') {
    command = `start "" "${absolutePath}"`;
  } else {
    command = `xdg-open "${absolutePath}"`;
  }

  exec(command, (err) => {
    if (err) {
      console.warn(`[次元旅人] 无法自动打开浏览器: ${err.message}`);
      console.log(`[次元旅人] 请手动打开: ${absolutePath}`);
    }
  });
}

// ========================================================
// CLI 入口
// ========================================================

/**
 * 解析命令行参数
 * 支持格式: --data=xxx --output=xxx --key=xxx --open
 */
function parseCliArgs() {
  const args = {};
  process.argv.slice(2).forEach((arg) => {
    if (arg.startsWith('--')) {
      const [key, ...valueParts] = arg.substring(2).split('=');
      args[key] = valueParts.length > 0 ? valueParts.join('=') : true;
    }
  });
  return args;
}

/**
 * CLI 主函数
 */
function main() {
  const args = parseCliArgs();

  // 帮助信息
  if (args.help || args.h) {
    console.log(`
次元旅人 - 地图可视化生成器

用法:
  node map-visualizer.js --data=<路线数据JSON> --output=<输出路径> [选项]

参数:
  --data      路线规划结果 JSON 文件路径（必填）
  --output    输出 HTML 文件路径（默认: tour-map.html）
  --key       高德 JSAPI Key（可选，也可通过环境变量 AMAP_JSAPI_KEY 设置）
  --open      生成后自动在浏览器中打开

示例:
  node map-visualizer.js --data=route_result.json --output=tour-map.html --open
`);
    process.exit(0);
  }

  // 校验必填参数
  if (!args.data) {
    console.error('[次元旅人] 错误: 请通过 --data 参数指定路线数据 JSON 文件');
    process.exit(1);
  }

  // 读取路线数据
  const dataPath = path.resolve(args.data);
  if (!fs.existsSync(dataPath)) {
    console.error(`[次元旅人] 错误: 数据文件不存在: ${dataPath}`);
    process.exit(1);
  }

  let routeResult;
  try {
    routeResult = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  } catch (err) {
    console.error(`[次元旅人] 错误: 解析 JSON 失败: ${err.message}`);
    process.exit(1);
  }

  // 输出路径
  const outputPath = args.output || 'tour-map.html';

  // 配置
  const config = {};
  if (args.key) {
    config.amapJsapiKey = args.key;
  }

  // 生成地图
  const generatedPath = generateMap(routeResult, outputPath, config);

  // 自动打开
  if (args.open) {
    openInBrowser(generatedPath);
  }
}

// 当直接运行脚本时执行 CLI
if (require.main === module) {
  main();
}

// ========================================================
// 模块导出
// ========================================================

module.exports = {
  generateMap,
  openInBrowser,
  TEMPLATE_PATH,
  resolveAmapKey
};
