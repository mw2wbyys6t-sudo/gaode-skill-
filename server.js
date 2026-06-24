/**
 * 次元旅人 - Web 服务器
 *
 * 功能：
 *   1. 提供静态文件服务（index.html 单页应用）
 *   2. 提供 /api/plan 接口，动态调用 pipeline 返回 JSON 数据
 *   3. 前端接收 JSON 后动态渲染高德地图（无需生成独立 HTML 文件）
 *
 * 启动：
 *   node server.js
 *   访问 http://localhost:3000
 */

'use strict';

const express = require('express');
const path = require('path');
const http = require('http');
const { runPipeline } = require('./scripts/pipeline');
const dialogueManager = require('./scripts/dialogue-manager');
const sessionStore = require('./scripts/session-store');

// 加载共享配置（用于提供 AMap Key 给前端动态加载地图）
const configPath = path.join(__dirname, 'config.json');
let sharedConfig = {};
try { sharedConfig = require(configPath); } catch (_) {}

const app = express();
const PORT = process.env.PORT || 3000;

// --- TTS 服务配置 ---
const TTS_HOST = process.env.TTS_HOST || '127.0.0.1';
const TTS_PORT = parseInt(process.env.TTS_PORT || '5050', 10);
let ttsAvailable = null;  // null=未检测, true=可用, false=不可用
let ttsEngineName = null; // TTS 引擎名称（从 Python 服务动态获取）

// --- 静态文件服务 ---
app.use(express.static(__dirname));
app.use(express.json({ limit: '1mb' }));

// --- CORS (开发用) ---
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // v2 fix: 处理 OPTIONS 预检请求
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// --- API: 动态规划路线（返回 JSON，前端动态渲染地图） ---
app.get('/api/plan', async (req, res) => {
  const input = req.query.input;
  const city = req.query.city || '';
  const mode = req.query.mode || 'scenic';  // scenic | food | mixed

  if (!input) {
    return res.status(400).json({ error: '缺少 input 参数' });
  }

  console.log(`\n[次元旅人] 收到规划请求: "${input}" (城市: ${city || '自动'}, 模式: ${mode})`);

  try {
    const summary = await runPipeline(input, {
      city: city || undefined,
      mode: mode,
      skipMap: true,
    });

    res.json({
      success: true,
      scenic_name: summary.scenic_name,
      city: summary.city,
      poi_count: summary.poi_count,
      scenic_count: summary.scenic_count || 0,
      food_count: summary.food_count || 0,
      total_duration: summary.total_duration,
      walking_time: summary.walking_time,
      mapData: summary.mapData,
      amapKey: sharedConfig.amapJsapiKey || '',
      amapSecurityCode: sharedConfig.amapSecurityJsCode || '',
    });
  } catch (err) {
    console.error('[次元旅人] 规划失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- API: 导览内容（返回 narration 文本和语音 URL） ---
app.get('/api/narration', async (req, res) => {
  const input = req.query.input;
  if (!input) {
    return res.status(400).json({ error: '缺少 input 参数' });
  }

  try {
    const summary = await runPipeline(input, {
      city: req.query.city || undefined,
      mode: req.query.mode || 'scenic',
      skipMap: true,
    });

    const mapData = summary.mapData || {};
    res.json({
      success: true,
      city_welcome: mapData.city_welcome || '',
      food_summary: mapData.food_summary || '',
      narrations: mapData.narrations || [],
      poi_count: summary.poi_count,
      scenic_count: summary.scenic_count || 0,
      food_count: summary.food_count || 0,
    });
  } catch (err) {
    console.error('[次元旅人] 导览内容生成失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- API: TTS 状态检查 ---
app.get('/api/tts/status', async (req, res) => {
  // 如果之前检测过，直接返回缓存结果
  if (ttsAvailable !== null) {
    return res.json({ available: ttsAvailable, engine: ttsEngineName || 'webspeech' });
  }

  // 探测 Python TTS 服务
  const checkReq = http.get(`http://${TTS_HOST}:${TTS_PORT}/tts/health`, { timeout: 2000 }, (r) => {
    let body = '';
    r.on('data', (chunk) => body += chunk);
    r.on('end', () => {
      try {
        const data = JSON.parse(body);
        ttsAvailable = data.status === 'ok';
        // 从 Python 服务获取引擎名称
        const engineClass = data.engine || '';
        if (engineClass.includes('Edge')) ttsEngineName = 'Edge-TTS';
        else if (engineClass.includes('LongCat') || engineClass.includes('AudioDiT')) ttsEngineName = 'LongCat-AudioDiT';
        else ttsEngineName = engineClass || 'unknown';
      } catch (_) {
        ttsAvailable = false;
      }
      res.json({ available: ttsAvailable, engine: ttsAvailable ? (ttsEngineName || 'unknown') : 'webspeech' });
    });
  });
  checkReq.on('error', () => { ttsAvailable = false; res.json({ available: false, engine: 'webspeech' }); });
  checkReq.on('timeout', () => { checkReq.destroy(); ttsAvailable = false; res.json({ available: false, engine: 'webspeech' }); });
});

// --- API: TTS 语音合成（代理到 Python 服务） ---
app.post('/api/tts', async (req, res) => {
  const { text, voice, speed } = req.body || {};
  if (!text) return res.status(400).json({ error: '缺少 text 参数' });

  // 转发到 Python TTS 服务
  const postData = JSON.stringify({ text, voice: voice || 'default', speed: speed || 1.0 });
  const options = {
    hostname: TTS_HOST,
    port: TTS_PORT,
    path: '/tts',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    timeout: 30000,
  };

  // v2 fix: 使用 responded 标志防止 timeout+error 双重响应
  let responded = false;
  const proxyReq = http.request(options, (proxyRes) => {
    if (responded) return;
    responded = true;
    const contentType = proxyRes.headers['content-type'] || 'audio/wav';
    res.set('Content-Type', contentType);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => {
    if (responded) return;
    responded = true;
    // TTS 服务不可用，返回 JSON 指令让前端使用 Web Speech API
    res.json({ engine: 'webspeech', text, voice: voice || 'default', speed: speed || 1.0 });
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (responded) return;
    responded = true;
    res.json({ engine: 'webspeech', text, voice: voice || 'default', speed: speed || 1.0 });
  });

  proxyReq.write(postData);
  proxyReq.end();
});

// --- API: 批量 TTS 合成（代理到 Python 服务） ---
app.post('/api/tts/batch', async (req, res) => {
  const { items, voice, speed } = req.body || {};
  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: '缺少 items 数组参数' });
  }

  const postData = JSON.stringify({ items, voice: voice || 'default', speed: speed || 1.0 });
  const options = {
    hostname: TTS_HOST,
    port: TTS_PORT,
    path: '/tts/batch',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    timeout: 60000,
  };

  // v2 fix: 使用 responded 标志防止 timeout+error 双重响应
  let batchResponded = false;
  const proxyReq = http.request(options, (proxyRes) => {
    let body = '';
    proxyRes.on('data', (chunk) => body += chunk);
    proxyRes.on('end', () => {
      if (batchResponded) return;
      batchResponded = true;
      try {
        res.json(JSON.parse(body));
      } catch (_) {
        res.status(500).json({ error: 'TTS 批量合成响应解析失败' });
      }
    });
  });

  proxyReq.on('error', () => {
    if (batchResponded) return;
    batchResponded = true;
    // TTS 不可用，返回全部回退指令
    const results = items.map((item, i) => ({
      id: item.id || String(i),
      text: item.text || '',
      has_audio: false,
      engine: 'webspeech'
    }));
    res.json({ results, total: results.length });
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (batchResponded) return;
    batchResponded = true;
    const results = items.map((item, i) => ({
      id: item.id || String(i),
      text: item.text || '',
      has_audio: false,
      engine: 'webspeech'
    }));
    res.json({ results, total: results.length });
  });

  proxyReq.write(postData);
  proxyReq.end();
});

// --- API: 小次对话（对话管理 + 意图路由） ---
app.post('/api/chat', async (req, res) => {
  const { sessionId, message, city } = req.body || {};

  if (!message) {
    return res.status(400).json({ error: '缺少 message 参数' });
  }

  const sid = sessionStore.resolveSessionId(sessionId || null);

  console.log(`\n[小次] 收到消息 (${sid}): "${message.slice(0, 60)}${message.length > 60 ? '...' : ''}"`);

  try {
    // 意图分类
    const history = sessionStore.getHistory(sid);
    const { intent } = dialogueManager.classifyIntent(message, history);

    // 如果意图是 plan，触发规划流水线
    if (intent === 'plan') {
      console.log(`[小次] 检测到规划意图，触发流水线...`);

      // 先让小次回复一条确认
      const chatResult = await dialogueManager.chat(
        message, sid, { city: city || undefined }
      );

      // 然后触发规划
      const planInput = message;
      const planCity = city || sessionStore.getSessionState(sid)?.city || '';

      try {
        const summary = await runPipeline(planInput, {
          city: planCity || undefined,
          mode: 'scenic',
          skipMap: true,
        });

        // 更新会话状态
        sessionStore.updateState(sid, {
          city: summary.city || planCity,
          scenicName: summary.scenic_name || '',
          currentPlan: {
            scenic_name: summary.scenic_name,
            city: summary.city,
            poi_count: summary.poi_count,
            total_duration: summary.total_duration,
          },
        });

        res.json({
          success: true,
          reply: chatResult.reply,
          cleanText: chatResult.cleanText,
          intent: 'plan',
          places: chatResult.places,
          routes: chatResult.routes,
          planData: {
            success: true,
            scenic_name: summary.scenic_name,
            city: summary.city,
            poi_count: summary.poi_count,
            scenic_count: summary.scenic_count || 0,
            food_count: summary.food_count || 0,
            total_duration: summary.total_duration,
            walking_time: summary.walking_time,
            mapData: summary.mapData,
            amapKey: sharedConfig.amapJsapiKey || '',
            amapSecurityCode: sharedConfig.amapSecurityJsCode || '',
          },
        });
      } catch (planErr) {
        console.error('[小次] 规划流水线失败:', planErr.message);
        // 规划失败但仍返回对话回复
        res.json({
          success: true,
          reply: chatResult.reply + '\n\n（抱歉，路线规划暂时出了点问题，请稍后再试。）',
          cleanText: chatResult.cleanText,
          intent: 'plan',
          places: chatResult.places,
          routes: chatResult.routes,
          planData: null,
        });
      }

    } else {
      // 非规划意图：直接对话回复
      const chatResult = await dialogueManager.chat(
        message, sid, { city: city || undefined }
      );

      res.json({
        success: true,
        reply: chatResult.reply,
        cleanText: chatResult.cleanText,
        intent: chatResult.intent,
        places: chatResult.places,
        routes: chatResult.routes,
      });
    }

  } catch (err) {
    console.error('[小次] 对话处理失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- API: 获取会话状态 ---
app.get('/api/session/:sessionId', (req, res) => {
  const state = sessionStore.getSessionState(req.params.sessionId);
  if (!state) {
    return res.json({ exists: false, state: null });
  }
  res.json({
    exists: true,
    state,
    activeSessions: sessionStore.getActiveCount(),
  });
});

// --- API: 更新会话状态（前端主动同步） ---
app.post('/api/session/:sessionId/state', (req, res) => {
  const patch = req.body || {};
  sessionStore.updateState(req.params.sessionId, patch);
  const state = sessionStore.getSessionState(req.params.sessionId);
  res.json({ success: true, state });
});

// --- 启动服务器 ---
app.listen(PORT, () => {
  console.log(`\n🌌 次元旅人 v2.0 服务器已启动`);
  console.log(`   访问 http://localhost:${PORT}`);
  console.log(`   规划 API    http://localhost:${PORT}/api/plan?input=...`);
  console.log(`   导览 API    http://localhost:${PORT}/api/narration?input=...`);
  console.log(`   对话 API    POST http://localhost:${PORT}/api/chat`);
  console.log(`   会话 API    http://localhost:${PORT}/api/session/:id`);
  console.log(`   语音 API    http://localhost:${PORT}/api/tts (后端 TTS: ${TTS_PORT})`);
  console.log(`   批量语音    http://localhost:${PORT}/api/tts/batch\n`);
});
