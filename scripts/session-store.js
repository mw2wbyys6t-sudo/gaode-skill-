/**
 * 次元旅人 - 会话状态存储
 *
 * 轻量级内存会话管理，用于跟踪用户状态和对话历史。
 * 支持会话过期自动清理。
 *
 * 数据结构：
 *   sessionId -> {
 *     createdAt, lastActive,
 *     messages: [{role, content}],
 *     state: { city, scenicName, preferences, recommendedPlaces, currentPlan }
 *   }
 */

'use strict';

// ============================================================
// 会话存储（内存 Map）
// ============================================================

const sessions = new Map();

// 默认配置
const DEFAULT_MAX_HISTORY = 20;   // 保留最近 N 轮对话
const DEFAULT_MAX_AGE_MS  = 2 * 60 * 60 * 1000; // 2小时过期
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;      // 每30分钟清理一次
const MAX_SESSIONS        = 500;                  // 最大会话数量


// ============================================================
// 核心函数
// ============================================================

/**
 * 获取或创建会话。
 * 若 sessionId 不存在则创建新会话，并返回。
 *
 * @param {string} sessionId - 会话唯一标识
 * @returns {Object} 会话对象
 */
function getOrCreateSession(sessionId) {
  // v2 fix: 当 sessionId 为 falsy 时生成随机 ID，并将其附加到返回对象上
  // 使调用方可以通过 session._id 获取真实的 sessionId
  if (!sessionId) {
    sessionId = 'anon_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  let session = sessions.get(sessionId);
  if (!session) {
    // 超限时淘汰最旧的会话
    if (sessions.size >= MAX_SESSIONS) {
      let oldestId = null;
      let oldestTime = Infinity;
      for (const [id, s] of sessions.entries()) {
        const t = s.lastActive.getTime();
        if (t < oldestTime) {
          oldestTime = t;
          oldestId = id;
        }
      }
      if (oldestId) {
        sessions.delete(oldestId);
        console.log(`[会话存储] 会话数超限(${MAX_SESSIONS})，已淘汰最旧会话: ${oldestId}`);
      }
    }

    session = {
      _id:          sessionId,     // v2: 暴露解析后的真实 ID
      createdAt:  new Date(),
      lastActive: new Date(),
      messages:   [],
      state: {
        city:              '',
        scenicName:        '',
        preferences:       {},        // { cuisine_types, budget_level, interests, ... }
        recommendedPlaces: [],        // [{ name, category, lng, lat }]
        currentPlan:       null,      // 当前规划结果摘要
      },
    };
    sessions.set(sessionId, session);
  } else {
    session.lastActive = new Date();
    session._id = sessionId;  // 确保 _id 始终是最新的
  }

  return session;
}


/**
 * 追加一条消息到会话历史。
 * 自动维护滑动窗口，超出 maxTurns 时裁剪最早的消息对。
 *
 * @param {string} sessionId
 * @param {string} role  - 'user' | 'assistant' | 'system'
 * @param {string} content - 消息文本
 * @param {number} [maxTurns=20] - 保留的最大对话轮数
 */
function addMessage(sessionId, role, content, maxTurns) {
  const session = getOrCreateSession(sessionId);
  maxTurns = maxTurns || DEFAULT_MAX_HISTORY;

  session.messages.push({ role, content });

  // 滑动窗口：保留最近 maxTurns 轮（每轮 = user + assistant 两条）
  const maxMessages = maxTurns * 2;
  if (session.messages.length > maxMessages) {
    session.messages = session.messages.slice(-maxMessages);
  }

  session.lastActive = new Date();
}


/**
 * 获取会话的最近对话历史（用于传给 LLM）。
 *
 * @param {string} sessionId
 * @param {number} [maxTurns=10] - 返回最近 N 轮
 * @returns {Array<{role: string, content: string}>}
 */
function getHistory(sessionId, maxTurns) {
  const session = sessions.get(sessionId);
  if (!session) return [];

  maxTurns = maxTurns || 10;
  const maxMessages = maxTurns * 2;
  return session.messages.slice(-maxMessages);
}


/**
 * 更新会话状态（浅合并）。
 *
 * @param {string} sessionId
 * @param {Object} patch - 要合并的状态字段
 */
function updateState(sessionId, patch) {
  const session = getOrCreateSession(sessionId);

  if (patch.city !== undefined)             session.state.city = patch.city;
  if (patch.scenicName !== undefined)       session.state.scenicName = patch.scenicName;
  if (patch.currentPlan !== undefined)      session.state.currentPlan = patch.currentPlan;

  // preferences 深合并
  if (patch.preferences && typeof patch.preferences === 'object') {
    session.state.preferences = Object.assign(
      {}, session.state.preferences, patch.preferences
    );
  }

  // recommendedPlaces 追加（去重）
  if (Array.isArray(patch.recommendedPlaces)) {
    const existing = new Set(session.state.recommendedPlaces.map(p => p.name));
    for (const place of patch.recommendedPlaces) {
      if (!existing.has(place.name)) {
        session.state.recommendedPlaces.push(place);
        existing.add(place.name);
      }
    }
  }

  session.lastActive = new Date();
}


/**
 * 获取会话状态。
 *
 * @param {string} sessionId
 * @returns {Object|null}
 */
function getSessionState(sessionId) {
  const session = sessions.get(sessionId);
  return session ? Object.assign({}, session.state) : null;
}


/**
 * 清理过期会话。
 *
 * @param {number} [maxAgeMs] - 最大存活时间（毫秒）
 * @returns {number} 清理掉的会话数量
 */
function cleanupExpired(maxAgeMs) {
  maxAgeMs = maxAgeMs || DEFAULT_MAX_AGE_MS;
  const now = Date.now();
  let cleaned = 0;

  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActive.getTime() > maxAgeMs) {
      sessions.delete(id);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[会话存储] 清理了 ${cleaned} 个过期会话，剩余 ${sessions.size} 个`);
  }
  return cleaned;
}


/**
 * 获取所有活跃会话的数量（调试用）。
 * @returns {number}
 */
function getActiveCount() {
  return sessions.size;
}


// ============================================================
// 自动清理定时器
// ============================================================

const cleanupTimer = setInterval(() => {
  cleanupExpired();
}, CLEANUP_INTERVAL_MS);

// 允许进程退出（不阻塞）
if (cleanupTimer.unref) {
  cleanupTimer.unref();
}


// ============================================================
// 导出
// ============================================================

module.exports = {
  getOrCreateSession,
  addMessage,
  getHistory,
  updateState,
  getSessionState,
  cleanupExpired,
  getActiveCount,
  // v2: 解析会话 ID，falsy 输入生成稳定的随机 ID 并预创建会话
  // 调用方应使用返回值作为后续所有操作的 sessionId
  resolveSessionId: (sessionId) => {
    const session = getOrCreateSession(sessionId);
    return session._id;
  },
};
