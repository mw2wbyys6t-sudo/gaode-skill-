/**
 * 餐饮选址通 - Word 选址报告生成器
 *
 * 功能：
 *   将选址分析结果（评分、竞争数据、商圈画像、LLM 建议）生成为
 *   专业排版的 .docx 文档，包含封面、雷达图、数据表格和对比分析。
 *
 * 依赖：
 *   - docx (npm)  — 声明式 Word 文档生成
 *   - sharp (npm) — SVG → PNG 渲染（雷达图）
 *
 * 导出：
 *   generateSiteReportDocx(reportData, outputPath)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber, PageBreak,
} = require('docx');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** A4 纸张尺寸 (DXA) */
const PAGE_WIDTH  = 11906;
const PAGE_HEIGHT = 16838;
const MARGIN      = 1440;  // 1 英寸
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;  // 9026 DXA

/** 评级颜色 */
const GRADE_COLORS = {
  '优秀': '52C41A',
  '良好': '1890FF',
  '及格': 'FA8C16',
  '不推荐': 'F5222D',
};

/** 评级默认色 */
const DEFAULT_GRADE_COLOR = '999999';

/** 表头样式 */
const HEADER_BG    = '1A1A2E';
const HEADER_FG    = 'FFFFFF';
const ALT_ROW_BG   = 'F7F8FA';

/** 边框定义 */
const BORDER_DEF = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const ALL_BORDERS = { top: BORDER_DEF, bottom: BORDER_DEF, left: BORDER_DEF, right: BORDER_DEF };

/** 五维评分标签 */
const DIMENSIONS = [
  { key: 'strategic',   label: '战略因素', icon: '🏙️' },
  { key: 'competition', label: '竞争因素', icon: '⚔️' },
  { key: 'sales',       label: '销售潜力', icon: '📈' },
  { key: 'service',     label: '服务配套', icon: '🚌' },
  { key: 'conditions',  label: '立地条件', icon: '🏗️' },
];

// ---------------------------------------------------------------------------
// SVG 雷达图生成
// ---------------------------------------------------------------------------

/**
 * 生成五边形雷达图 SVG 字符串
 * @param {Object} breakdown - { strategic, competition, sales, service, conditions }
 * @param {number} [size=240] - SVG 尺寸
 * @returns {string} SVG 字符串
 */
function buildRadarSvg(breakdown, size = 240) {
  const cx = size / 2;
  const cy = size / 2;
  const r  = size * 0.375;  // 90 for 240

  const labels = DIMENSIONS.map(d => d.label);
  const values = DIMENSIONS.map(d => (breakdown[d.key] || 0) / 20);  // 归一化 0-1
  const n = 5;

  // 角度计算（从顶部开始，顺时针）
  const angle = (i) => (Math.PI * 2 * i / n) - Math.PI / 2;
  const point = (i, ratio) => ({
    x: cx + r * ratio * Math.cos(angle(i)),
    y: cy + r * ratio * Math.sin(angle(i)),
  });

  // 网格层
  let gridLines = '';
  for (let level = 1; level <= 3; level++) {
    const ratio = level / 3;
    const pts = Array.from({ length: n }, (_, i) => point(i, ratio));
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z';
    gridLines += `<path d="${d}" fill="none" stroke="#E0E0E0" stroke-width="0.8"/>`;
  }

  // 轴线
  let axisLines = '';
  for (let i = 0; i < n; i++) {
    const p = point(i, 1);
    axisLines += `<line x1="${cx}" y1="${cy}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" stroke="#D0D0D0" stroke-width="0.6"/>`;
  }

  // 数据多边形
  const dataPts = values.map((v, i) => point(i, v));
  const dataPath = dataPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z';

  // 数据点
  let dataPoints = '';
  for (const p of dataPts) {
    dataPoints += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="#1890FF" stroke="#fff" stroke-width="1.5"/>`;
  }

  // 标签
  let labelSvg = '';
  for (let i = 0; i < n; i++) {
    const p = point(i, 1.28);
    const anchor = p.x < cx - 10 ? 'end' : p.x > cx + 10 ? 'start' : 'middle';
    const score = breakdown[DIMENSIONS[i].key] || 0;
    labelSvg += `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="${anchor}" font-size="11" fill="#333" font-family="Arial,sans-serif">${labels[i]} (${score})</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="white"/>
  ${gridLines}${axisLines}
  <path d="${dataPath}" fill="rgba(24,144,255,0.18)" stroke="#1890FF" stroke-width="2"/>
  ${dataPoints}${labelSvg}
</svg>`;
}

/**
 * 将 SVG 字符串转换为 PNG Buffer
 * @param {string} svgString - SVG 内容
 * @param {number} [scale=2] - 渲染倍率
 * @returns {Promise<Buffer>} PNG Buffer
 */
async function svgToPng(svgString, scale = 2) {
  try {
    const sharp = require('sharp');
    const pngBuffer = await sharp(Buffer.from(svgString))
      .resize(240 * scale, 240 * scale)
      .png()
      .toBuffer();
    return pngBuffer;
  } catch (err) {
    console.warn(`[Word报告] 雷达图 PNG 渲染失败: ${err.message}，跳过雷达图`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 表格构建工具
// ---------------------------------------------------------------------------

/**
 * 创建带样式的表格单元格
 */
function makeCell(text, opts = {}) {
  const { bold, bg, fg, width, align, font_size } = opts;
  return new TableCell({
    borders: ALL_BORDERS,
    width: width ? { size: width, type: WidthType.DXA } : undefined,
    shading: bg ? { fill: bg, type: ShadingType.CLEAR } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({
      alignment: align || AlignmentType.LEFT,
      children: [new TextRun({
        text: String(text),
        bold: bold || false,
        color: fg || '333333',
        font: 'Arial',
        size: font_size || 20,  // 10pt
      })],
    })],
  });
}

/**
 * 创建表头行
 */
function makeHeaderRow(labels, widths) {
  return new TableRow({
    children: labels.map((label, i) =>
      makeCell(label, { bold: true, bg: HEADER_BG, fg: HEADER_FG, width: widths[i], align: AlignmentType.CENTER })
    ),
  });
}

/**
 * 创建数据行（交替行背景）
 */
function makeDataRow(cells, widths, rowIndex) {
  const bg = rowIndex % 2 === 1 ? ALT_ROW_BG : undefined;
  return new TableRow({
    children: cells.map((cell, i) =>
      makeCell(cell.text || cell, { width: widths[i], bg, bold: cell.bold, fg: cell.fg, align: cell.align })
    ),
  });
}

// ---------------------------------------------------------------------------
// 文档章节构建
// ---------------------------------------------------------------------------

/** 封面页 */
function buildCoverPage(reportData) {
  const intent = reportData.intent || {};
  const scores = reportData.scores || [];
  const bestScore = scores.length > 0 ? scores.reduce((a, b) => (a.total > b.total ? a : b)) : null;
  const gradeColor = bestScore ? (GRADE_COLORS[bestScore.grade] || DEFAULT_GRADE_COLOR) : DEFAULT_GRADE_COLOR;

  const date = reportData.generated_at
    ? new Date(reportData.generated_at).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
    : new Date().toLocaleDateString('zh-CN');

  const children = [
    new Paragraph({ spacing: { before: 3000 }, children: [] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: '餐饮选址通', font: 'Arial', size: 56, bold: true, color: '1A1A2E' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 600 },
      children: [new TextRun({ text: '选址分析报告', font: 'Arial', size: 44, color: '666666' })],
    }),
    // 分隔线
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 600 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 3, color: '1890FF', space: 10 } },
      children: [],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [
        new TextRun({ text: `餐饮类型：${intent.restaurant_type || '未指定'}`, font: 'Arial', size: 24, color: '666666' }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [
        new TextRun({ text: `目标城市：${intent.city || '未指定'}`, font: 'Arial', size: 24, color: '666666' }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [
        new TextRun({ text: `候选区域：${(intent.target_areas || []).join('、') || '未指定'}`, font: 'Arial', size: 24, color: '666666' }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 600 },
      children: [
        new TextRun({ text: `生成日期：${date}`, font: 'Arial', size: 24, color: '666666' }),
      ],
    }),
  ];

  // 总分展示
  if (bestScore) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 100 },
        children: [new TextRun({ text: String(bestScore.total), font: 'Arial', size: 96, bold: true, color: gradeColor })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: `/ 100 分  ·  ${bestScore.grade}`, font: 'Arial', size: 28, color: gradeColor })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: bestScore.recommendation || '', font: 'Arial', size: 24, color: '999999' })],
      }),
    );
  }

  children.push(new Paragraph({ children: [new PageBreak()] }));
  return children;
}

/** 评分总览 + 雷达图 */
async function buildScoreSection(score, areaName) {
  const children = [];
  const gradeColor = GRADE_COLORS[score.grade] || DEFAULT_GRADE_COLOR;

  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 240, after: 240 },
    children: [new TextRun({ text: `${areaName} — 评分详情`, font: 'Arial', bold: true, size: 32 })],
  }));

  // 总分行
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 300 },
    children: [
      new TextRun({ text: `${score.total}`, font: 'Arial', size: 72, bold: true, color: gradeColor }),
      new TextRun({ text: ` / 100 分  (${score.grade})`, font: 'Arial', size: 28, color: gradeColor }),
    ],
  }));

  // 五维评分表
  const colWidths = [Math.round(CONTENT_WIDTH * 0.3), Math.round(CONTENT_WIDTH * 0.2), Math.round(CONTENT_WIDTH * 0.5)];
  const rows = [makeHeaderRow(['评分维度', '得分', '说明'], colWidths)];

  const dimDescriptions = {
    strategic: '城市等级 + 商圈类型 + 发展趋势',
    competition: '核心圈竞争密度 + 同品类占比（反直觉）',
    sales: '人流代理指标 + 捕获率估算',
    service: '互补业态评分 + 交通可达性',
    conditions: '区域类型 + 街道可达性 + 物业可行性',
  };

  DIMENSIONS.forEach((dim, i) => {
    const val = score.breakdown?.[dim.key] || 0;
    rows.push(makeDataRow([
      `${dim.icon} ${dim.label}`,
      { text: `${val} / 20`, bold: true, fg: val >= 15 ? '52C41A' : val >= 10 ? '1890FF' : val >= 5 ? 'FA8C16' : 'F5222D' },
      dimDescriptions[dim.key] || '',
    ], colWidths, i));
  });

  children.push(new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: colWidths,
    rows,
  }));

  // 雷达图
  const svgStr = buildRadarSvg(score.breakdown || {});
  const pngBuf = await svgToPng(svgStr);
  if (pngBuf) {
    children.push(
      new Paragraph({ spacing: { before: 300 }, children: [] }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({
          type: 'png',
          data: pngBuf,
          transformation: { width: 300, height: 300 },
          altText: { title: '雷达图', description: '五维评分雷达图', name: 'radar-chart' },
        })],
      }),
    );
  }

  return children;
}

/** 竞争密度分析 */
function buildCompetitionSection(area, areaName) {
  const children = [];
  const comp = area.competition || {};
  const rings = comp.rings || {};

  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 240 },
    children: [new TextRun({ text: `${areaName} — 竞争密度分析`, font: 'Arial', bold: true, size: 32 })],
  }));

  // 四层同心圆表
  const colWidths = [
    Math.round(CONTENT_WIDTH * 0.2),
    Math.round(CONTENT_WIDTH * 0.2),
    Math.round(CONTENT_WIDTH * 0.2),
    Math.round(CONTENT_WIDTH * 0.2),
    Math.round(CONTENT_WIDTH * 0.2),
  ];
  const ringLabels = [
    { key: 'core',   label: '核心圈 150m', purpose: '直接竞争' },
    { key: 'inner',  label: '内圈 500m',    purpose: '竞争分类' },
    { key: 'middle', label: '中圈 1km',     purpose: '市场分析' },
    { key: 'outer',  label: '外圈 3km',     purpose: '宏观画像' },
  ];

  const rows = [makeHeaderRow(['扫描半径', '用途', '餐饮数', '饮品数', '合计'], colWidths)];
  ringLabels.forEach((rl, i) => {
    const ring = rings[rl.key] || {};
    rows.push(makeDataRow([
      rl.label,
      rl.purpose,
      String(ring.food_count || 0),
      String(ring.drink_count || 0),
      { text: String(ring.total_count || 0), bold: true },
    ], colWidths, i));
  });

  children.push(new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: colWidths,
    rows,
  }));

  // 菜系分布表
  const innerRing = rings.inner || rings.core || {};
  const cuisineBreakdown = innerRing.cuisine_breakdown || {};
  const cuisineEntries = Object.entries(cuisineBreakdown).slice(0, 10);

  if (cuisineEntries.length > 0) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 300, after: 180 },
      children: [new TextRun({ text: '菜系分布（500m 内圈）', font: 'Arial', bold: true, size: 26 })],
    }));

    const cColWidths = [
      Math.round(CONTENT_WIDTH * 0.4),
      Math.round(CONTENT_WIDTH * 0.2),
      Math.round(CONTENT_WIDTH * 0.2),
      Math.round(CONTENT_WIDTH * 0.2),
    ];
    const totalFood = innerRing.food_count || 1;
    const cRows = [makeHeaderRow(['菜系', '数量', '占比', '竞争评估'], cColWidths)];
    cuisineEntries.forEach(([name, count], i) => {
      const ratio = Math.round(count / totalFood * 100);
      const assess = ratio > 30 ? '高竞争' : ratio > 15 ? '中等' : '有空间';
      const assessColor = ratio > 30 ? 'F5222D' : ratio > 15 ? 'FA8C16' : '52C41A';
      cRows.push(makeDataRow([
        name,
        String(count),
        `${ratio}%`,
        { text: assess, fg: assessColor, bold: true },
      ], cColWidths, i));
    });

    children.push(new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: cColWidths,
      rows: cRows,
    }));
  }

  return children;
}

/** 商圈画像 */
function buildProfileSection(area, areaName) {
  const children = [];
  const profile = area.profile || {};

  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 240 },
    children: [new TextRun({ text: `${areaName} — 商圈画像`, font: 'Arial', bold: true, size: 32 })],
  }));

  // 商圈属性表
  const colWidths = [Math.round(CONTENT_WIDTH * 0.35), Math.round(CONTENT_WIDTH * 0.65)];
  const typeLabels = { commercial: '商业核心区', residential: '居民生活区', mixed: '商住混合区' };
  const typeLabel = typeLabels[profile.areaType] || profile.areaType || '未知';

  const rows = [
    makeDataRow(['商圈类型', { text: typeLabel, bold: true }], colWidths, 0),
    makeDataRow(['交通便利度', `${profile.transitScore || 0} / 10`], colWidths, 1),
    makeDataRow(['互补业态评分', `${profile.complementaryScore || 0} / 10`], colWidths, 2),
    makeDataRow(['商业 POI 数', String(profile.commercialCount || 0)], colWidths, 3),
    makeDataRow(['住宅 POI 数', String(profile.residentialCount || 0)], colWidths, 4),
  ];

  children.push(new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: colWidths,
    rows,
  }));

  // 画像叙事
  if (profile.narrative) {
    children.push(
      new Paragraph({ spacing: { before: 200 }, children: [] }),
      new Paragraph({
        spacing: { after: 200 },
        border: { left: { style: BorderStyle.SINGLE, size: 6, color: '1890FF', space: 10 } },
        indent: { left: 300 },
        children: [new TextRun({ text: profile.narrative, font: 'Arial', size: 22, color: '555555', italics: true })],
      }),
    );
  }

  return children;
}

/** 多商圈对比 */
function buildComparisonSection(comparison, scores) {
  const children = [];
  if (!comparison || !scores || scores.length < 2) return children;

  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 240 },
    children: [new TextRun({ text: '多商圈对比分析', font: 'Arial', bold: true, size: 32 })],
  }));

  // 对比表
  const dimCount = DIMENSIONS.length;
  const areaCount = scores.length;
  const firstColWidth = Math.round(CONTENT_WIDTH * 0.2);
  const areaColWidth = Math.round((CONTENT_WIDTH - firstColWidth) / areaCount);
  const colWidths = [firstColWidth, ...Array(areaCount).fill(areaColWidth)];

  const headerLabels = ['评分维度', ...scores.map(s => s.area_name || '区域')];
  const rows = [makeHeaderRow(headerLabels, colWidths)];

  // 总分行
  const totalCells = scores.map(s => {
    const isBest = comparison.best && s.area_name === comparison.best.area_name;
    return { text: `${s.total} (${s.grade})`, bold: true, fg: isBest ? '52C41A' : '333333' };
  });
  rows.push(makeDataRow([{ text: '总分', bold: true }, ...totalCells], colWidths, 0));

  // 各维度
  DIMENSIONS.forEach((dim, i) => {
    const cells = scores.map(s => String(s.breakdown?.[dim.key] || 0));
    rows.push(makeDataRow([dim.label, ...cells], colWidths, i + 1));
  });

  children.push(new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: colWidths,
    rows,
  }));

  // 推荐首选
  if (comparison.best) {
    children.push(new Paragraph({
      spacing: { before: 200, after: 100 },
      children: [
        new TextRun({ text: '🏆 推荐首选：', font: 'Arial', size: 24, bold: true, color: '1890FF' }),
        new TextRun({ text: `${comparison.best.area_name} (${comparison.best.total} 分)`, font: 'Arial', size: 24, bold: true }),
        new TextRun({ text: ` — ${comparison.best.reason || '综合评分最高'}`, font: 'Arial', size: 22, color: '666666' }),
      ],
    }));
  }

  return children;
}

/** LLM 综合建议 */
function buildRecommendationSection(recommendation) {
  const children = [];
  if (!recommendation) return children;

  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 240 },
    children: [new TextRun({ text: 'AI 综合建议', font: 'Arial', bold: true, size: 32 })],
  }));

  const paragraphs = recommendation.split(/\n\n+/).filter(Boolean);
  for (const para of paragraphs) {
    children.push(new Paragraph({
      spacing: { after: 160 },
      children: [new TextRun({ text: para.trim(), font: 'Arial', size: 22, color: '333333' })],
    }));
  }

  return children;
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

/**
 * 生成 Word 选址分析报告
 *
 * @param {Object} reportData - 完整报告数据（同 site-pipeline.js 输出的 reportData）
 * @param {string} outputPath - 输出文件路径（.docx）
 * @returns {Promise<string>} 输出文件的绝对路径
 */
async function generateSiteReportDocx(reportData, outputPath) {
  const absOutput = path.resolve(outputPath);

  console.log('[Word报告] 开始生成选址分析报告...');

  const scores = reportData.scores || [];
  const areas  = reportData.areas  || [];

  // 构建文档各章节
  const coverChildren = buildCoverPage(reportData);

  // 每个区域的评分、竞争、画像章节
  const areaSections = [];
  for (let i = 0; i < areas.length; i++) {
    const area = areas[i];
    const score = scores[i] || {};
    const areaName = area.area_name || `区域 ${i + 1}`;

    const scoreSection = await buildScoreSection(score, areaName);
    const compSection  = buildCompetitionSection(area, areaName);
    const profileSection = buildProfileSection(area, areaName);

    areaSections.push(...scoreSection, ...compSection, ...profileSection);

    // 多区域时加页分隔
    if (i < areas.length - 1) {
      areaSections.push(new Paragraph({ children: [new PageBreak()] }));
    }
  }

  // 对比章节
  const compChildren = buildComparisonSection(reportData.comparison, scores);

  // LLM 建议章节
  const llmChildren = buildRecommendationSection(reportData.recommendation);

  // 组装文档
  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: 'Arial', size: 22 } },
      },
      paragraphStyles: [
        {
          id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 32, bold: true, font: 'Arial', color: '1A1A2E' },
          paragraph: { spacing: { before: 360, after: 240 }, outlineLevel: 0 },
        },
        {
          id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 26, bold: true, font: 'Arial', color: '333333' },
          paragraph: { spacing: { before: 240, after: 180 }, outlineLevel: 1 },
        },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
          margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: '餐饮选址通 · 选址分析报告', font: 'Arial', size: 16, color: 'AAAAAA' })],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: '餐饮选址通  |  第 ', font: 'Arial', size: 16, color: '999999' }),
              new TextRun({ children: [PageNumber.CURRENT], font: 'Arial', size: 16, color: '999999' }),
              new TextRun({ text: ' 页', font: 'Arial', size: 16, color: '999999' }),
            ],
          })],
        }),
      },
      children: [
        ...coverChildren,
        ...areaSections,
        ...(compChildren.length > 0 ? [new Paragraph({ children: [new PageBreak()] }), ...compChildren] : []),
        ...(llmChildren.length > 0 ? [new Paragraph({ children: [new PageBreak()] }), ...llmChildren] : []),
      ],
    }],
  });

  // 输出
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(absOutput, buffer);

  console.log(`[Word报告] 报告已保存至: ${absOutput} (${(buffer.length / 1024).toFixed(1)} KB)`);
  return absOutput;
}

// ---------------------------------------------------------------------------
// CLI 入口（可选，用于独立测试）
// ---------------------------------------------------------------------------

if (require.main === module) {
  // 读取 JSON 数据文件并生成 Word 报告
  const args = process.argv.slice(2).reduce((acc, arg) => {
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (match) {
      acc[match[1]] = match[2] !== undefined ? match[2] : true;
    }
    return acc;
  }, {});

  if (!args.input) {
    console.error('用法: node site-report-docx.js --input=data.json [--output=report.docx]');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(args.input, 'utf-8'));
  const output = args.output || 'site-report.docx';

  generateSiteReportDocx(data, output)
    .then(p => console.log(`完成: ${p}`))
    .catch(err => { console.error(`失败: ${err.message}`); process.exit(1); });
}

// ---------------------------------------------------------------------------
// 模块导出
// ---------------------------------------------------------------------------

module.exports = { generateSiteReportDocx, buildRadarSvg };
