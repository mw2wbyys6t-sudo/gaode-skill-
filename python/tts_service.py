#!/usr/bin/env python3
"""
次元旅人 - TTS 语音合成服务

双模式运行：
  1. Flask HTTP 服务（默认）：node server.js 通过 /api/tts 代理调用
  2. CLI 单次推理：python tts_service.py --text "景点介绍" --output output.mp3

依赖安装：
  pip install flask

LongCat-AudioDiT 集成（可选，需 GPU）：
  pip install torch torchaudio
  git clone https://github.com/meituan-longcat/LongCat-AudioDiT.git
  按 AudioDiT README 下载预训练模型

启动服务：
  python tts_service.py                  # 默认端口 5050
  python tts_service.py --port 5051      # 自定义端口
"""

import os
import sys
import json
import argparse
import hashlib
import time
import asyncio
from pathlib import Path

# ============================================================
# TTS 引擎抽象层
# ============================================================

class TTSEngine:
    """TTS 引擎基类"""
    def synthesize(self, text: str, voice: str = "default", speed: float = 1.0) -> bytes:
        raise NotImplementedError


class LongCatAudioDiTEngine(TTSEngine):
    """
    LongCat-AudioDiT 本地推理引擎
    需要 GPU 和预训练模型，详见：
    https://github.com/meituan-longcat/LongCat-AudioDiT
    """

    def __init__(self, model_dir: str = None, device: str = "cuda"):
        self.model_dir = model_dir or os.environ.get(
            "AUDIO_DIT_MODEL_DIR",
            os.path.join(os.path.dirname(__file__), "models", "LongCat-AudioDiT")
        )
        self.device = device
        self._model = None

    def _load_model(self):
        if self._model is not None:
            return
        try:
            # 尝试导入 AudioDiT
            sys.path.insert(0, self.model_dir)
            from inference import load_model  # AudioDiT 的推理入口
            self._model = load_model(device=self.device)
            print(f"[TTS] LongCat-AudioDiT 模型已加载 (device={self.device})")
        except ImportError:
            raise RuntimeError(
                f"LongCat-AudioDiT 未安装。请克隆仓库到 {self.model_dir} 并安装依赖。"
                f"详见: https://github.com/meituan-longcat/LongCat-AudioDiT"
            )

    def synthesize(self, text: str, voice: str = "default", speed: float = 1.0) -> bytes:
        self._load_model()
        import tempfile
        import torchaudio

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name

        try:
            # AudioDiT 推理（具体 API 以官方 README 为准）
            waveform = self._model.synthesize(
                text=text,
                speaker_id=voice,
                speed=speed,
                output_path=tmp_path
            )
            with open(tmp_path, "rb") as f:
                audio_data = f.read()
            return audio_data
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)


class WebSpeechFallback:
    """
    当 LongCat-AudioDiT 不可用时，返回标记让前端使用 Web Speech API。
    不生成实际音频，只返回 JSON 指令。
    """
    def synthesize(self, text: str, voice: str = "default", speed: float = 1.0) -> bytes:
        result = json.dumps({
            "engine": "webspeech",
            "text": text,
            "voice": voice,
            "speed": speed,
            "message": "后端 TTS 不可用，请使用浏览器 Web Speech API"
        }, ensure_ascii=False)
        return result.encode("utf-8")


# ============================================================
# Edge TTS 引擎（微软神经网络语音）
# ============================================================

# 小次角色语音配置
# zh-CN-XiaoxiaoNeural: 甜美女声，年轻活泼，适合二次元角色
# 其他可选：zh-CN-XiaoyiNeural(温柔), zh-CN-liaoning-XiaobeiNeural(东北)
EDGE_VOICE_MAP = {
    "default":     "zh-CN-XiaoxiaoNeural",   # 默认：甜美少女（小次）
    "xiaoxiao":    "zh-CN-XiaoxiaoNeural",   # 甜美活泼
    "xiaoyi":      "zh-CN-XiaoyiNeural",     # 温柔知性
    "yunxi":       "zh-CN-YunxiNeural",      # 年轻男声
    "yunyang":     "zh-CN-YunyangNeural",    # 新闻男声
}

class EdgeTTSEngine(TTSEngine):
    """
    微软 Edge TTS 引擎（通过 edge-tts 库）

    特点：
      - 免费，无需 API Key
      - 高质量神经网络语音
      - 支持调节语速和音调
      - 默认使用 zh-CN-XiaoxiaoNeural（甜美女声，适合小次角色）
    """

    def __init__(self, default_voice: str = "default"):
        self.default_voice = default_voice
        self._voice_name = EDGE_VOICE_MAP.get(default_voice, EDGE_VOICE_MAP["default"])
        self._proxy = self._detect_proxy()
        print(f"[TTS] Edge TTS 引擎初始化: voice={self._voice_name}, proxy={self._proxy or 'none'}")

    @staticmethod
    def _detect_proxy() -> str | None:
        """检测系统代理（环境变量优先，然后 Windows 系统代理）"""
        import os
        # 1. 环境变量
        for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
            val = os.environ.get(key)
            if val:
                return val
        # 2. Windows 注册表（IE/系统代理）
        if os.name == "nt":
            try:
                import winreg
                key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                     r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
                enabled, _ = winreg.QueryValueEx(key, "ProxyEnable")
                if enabled:
                    server, _ = winreg.QueryValueEx(key, "ProxyServer")
                    winreg.CloseKey(key)
                    if server and "://" not in server:
                        server = "http://" + server
                    return server
                winreg.CloseKey(key)
            except Exception:
                pass
        return None

    def _rate_string(self, speed: float) -> str:
        """将 speed 浮点数转换为 edge-tts 的 rate 格式（如 +10%, -20%）"""
        # speed 0.5~2.0 → rate -50% ~ +100%
        pct = int((speed - 1.0) * 100)
        if pct >= 0:
            return f"+{pct}%"
        return f"{pct}%"

    def synthesize(self, text: str, voice: str = "default", speed: float = 1.0) -> bytes:
        """
        使用 edge-tts 合成语音，返回 WAV 格式的 bytes。
        """
        try:
            import edge_tts
        except ImportError:
            print("[TTS] edge-tts 未安装，请运行: pip install edge-tts")
            return WebSpeechFallback().synthesize(text, voice, speed)

        # 确定语音角色
        voice_name = EDGE_VOICE_MAP.get(voice, self._voice_name)
        rate = self._rate_string(speed)

        # edge-tts 是异步的，需要在同步上下文中运行
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # 如果事件循环已在运行（Flask 环境），创建新线程
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    audio_data = pool.submit(
                        asyncio.run, self._synthesize_async(text, voice_name, rate)
                    ).result(timeout=30)
            else:
                audio_data = loop.run_until_complete(
                    self._synthesize_async(text, voice_name, rate)
                )
        except RuntimeError:
            audio_data = asyncio.run(
                self._synthesize_async(text, voice_name, rate)
            )

        return audio_data

    async def _synthesize_async(self, text: str, voice: str, rate: str) -> bytes:
        """异步合成方法"""
        import edge_tts

        kwargs = {"rate": rate}
        if self._proxy:
            kwargs["proxy"] = self._proxy

        communicate = edge_tts.Communicate(text, voice, **kwargs)
        audio_chunks = []

        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_chunks.append(chunk["data"])

        if not audio_chunks:
            raise RuntimeError("Edge TTS 未返回音频数据")

        return b"".join(audio_chunks)

    def warmup(self):
        """
        后台预热：合成一段极短文本，预建立到微软 Edge TTS 服务器的 HTTPS 连接，
        减少首次真实请求的延迟。
        """
        import threading

        def _do_warmup():
            try:
                print("[TTS] 预热 Edge TTS 连接中...")
                data = self.synthesize("嗯", "default", 1.0)
                print(f"[TTS] 预热完成 ({len(data)} bytes)，首次调用将更快")
            except Exception as e:
                print(f"[TTS] 预热失败（不影响正常使用）: {e}")

        t = threading.Thread(target=_do_warmup, daemon=True)
        t.start()
        return t


# ============================================================
# 缓存层
# ============================================================

class TTSCache:
    """简单的文件缓存，避免重复合成相同文本"""

    def __init__(self, cache_dir: str = None):
        self.cache_dir = cache_dir or os.path.join(
            os.path.dirname(__file__), "..", ".tts-cache"
        )
        os.makedirs(self.cache_dir, exist_ok=True)

    def _cache_key(self, text: str, voice: str, speed: float) -> str:
        raw = f"{text}|{voice}|{speed}"
        return hashlib.md5(raw.encode("utf-8")).hexdigest()

    def get(self, text: str, voice: str, speed: float) -> bytes | None:
        key = self._cache_key(text, voice, speed)
        path = os.path.join(self.cache_dir, f"{key}.wav")
        if os.path.exists(path):
            age = time.time() - os.path.getmtime(path)
            if age < 86400:  # 24 小时 TTL
                with open(path, "rb") as f:
                    return f.read()
        return None

    def put(self, text: str, voice: str, speed: float, data: bytes):
        key = self._cache_key(text, voice, speed)
        path = os.path.join(self.cache_dir, f"{key}.wav")
        with open(path, "wb") as f:
            f.write(data)


def detect_audio_mimetype(data: bytes) -> str:
    """根据文件头魔字节检测音频格式，返回正确的 MIME 类型"""
    if not data:
        return "audio/wav"
    # MP3: 以 ID3 标签开头 或 以 0xFF 0xFB/0xFF 0xF3/0xFF 0xF2 帧同步开头
    if data[:3] == b"ID3":
        return "audio/mpeg"
    if len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        return "audio/mpeg"
    # WAV: RIFF 头
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    # OGG: OggS 头
    if data[:4] == b"OggS":
        return "audio/ogg"
    # 默认当作 wav
    return "audio/wav"


# ============================================================
# Flask HTTP 服务
# ============================================================

def create_app(engine: TTSEngine, cache: TTSCache):
    try:
        from flask import Flask, request, jsonify, Response
    except ImportError:
        print("[TTS] Flask 未安装，请运行: pip install flask")
        sys.exit(1)

    app = Flask(__name__)

    @app.route("/tts", methods=["POST"])
    def tts_synthesize():
        """
        TTS 合成端点

        请求 JSON:
        {
            "text": "景点介绍文本",
            "voice": "default",     // 可选，音色 ID
            "speed": 1.0            // 可选，语速
        }

        响应:
          - 成功（AudioDiT）: audio/wav 二进制流
          - 回退（Web Speech）: application/json 指令
        """
        data = request.get_json(force=True, silent=True) or {}
        text = data.get("text", "").strip()
        voice = data.get("voice", "default")
        speed = float(data.get("speed", 1.0))

        if not text:
            return jsonify({"error": "缺少 text 参数"}), 400

        # 检查缓存
        cached = cache.get(text, voice, speed)
        if cached:
            # 判断是音频还是 JSON 回退指令
            if cached[:1] == b"{":
                return Response(cached, mimetype="application/json")
            return Response(cached, mimetype=detect_audio_mimetype(cached))

        # 合成
        try:
            audio_data = engine.synthesize(text, voice, speed)
            cache.put(text, voice, speed, audio_data)

            # 判断返回类型
            if audio_data[:1] == b"{":
                return Response(audio_data, mimetype="application/json")
            return Response(audio_data, mimetype=detect_audio_mimetype(audio_data))

        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.route("/tts/health", methods=["GET"])
    def health():
        engine_type = type(engine).__name__
        return jsonify({
            "status": "ok",
            "engine": engine_type,
            "model_loaded": getattr(engine, "_model", None) is not None
        })

    @app.route("/tts/batch", methods=["POST"])
    def tts_batch():
        """
        批量 TTS 合成端点

        请求 JSON:
        {
            "items": [
                { "text": "第一段文本", "id": "welcome" },
                { "text": "第二段文本", "id": "seg_0" },
                ...
            ],
            "voice": "default",   // 可选
            "speed": 0.95          // 可选
        }

        响应 JSON:
        {
            "results": [
                { "id": "welcome", "text": "...", "has_audio": true, "size": 12345 },
                { "id": "seg_0", "text": "...", "has_audio": false },
                ...
            ]
        }
        """
        data = request.get_json(force=True, silent=True) or {}
        items = data.get("items", [])
        voice = data.get("voice", "default")
        speed = float(data.get("speed", 1.0))

        if not items:
            return jsonify({"error": "缺少 items 参数"}), 400

        results = []
        for item in items:
            text = (item.get("text", "") or "").strip()
            item_id = item.get("id", str(len(results)))
            if not text:
                results.append({"id": item_id, "text": "", "has_audio": False, "error": "空文本"})
                continue

            # 检查缓存
            cached = cache.get(text, voice, speed)
            if cached and cached[:1] != b"{":
                results.append({
                    "id": item_id,
                    "text": text,
                    "has_audio": True,
                    "cached": True,
                    "size": len(cached)
                })
                continue

            # 合成
            try:
                audio_data = engine.synthesize(text, voice, speed)
                if audio_data[:1] == b"{":
                    # Web Speech 回退
                    results.append({"id": item_id, "text": text, "has_audio": False})
                else:
                    cache.put(text, voice, speed, audio_data)
                    results.append({
                        "id": item_id,
                        "text": text,
                        "has_audio": True,
                        "size": len(audio_data)
                    })
            except Exception as e:
                results.append({"id": item_id, "text": text, "has_audio": False, "error": str(e)})

        return jsonify({"results": results, "total": len(results)})

    return app


# ============================================================
# CLI 入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="次元旅人 TTS 语音合成服务")
    parser.add_argument("--port", type=int, default=5050, help="HTTP 服务端口 (默认 5050)")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址 (默认 127.0.0.1)")
    parser.add_argument("--engine", choices=["audiodit", "edge", "webspeech"], default="edge",
                        help="TTS 引擎: edge (微软神经网络,默认) 或 audiodit (LongCat) 或 webspeech (回退)")
    parser.add_argument("--text", help="CLI 模式: 直接合成指定文本")
    parser.add_argument("--output", default="tts_output.wav", help="CLI 模式: 输出文件路径")
    parser.add_argument("--device", default="cuda", help="推理设备: cuda 或 cpu")
    parser.add_argument("--model-dir", help="AudioDiT 模型目录")
    parser.add_argument("--voice", default="default",
                        help="语音角色ID (默认 default/XiaoxiaoNeural)")

    args = parser.parse_args()

    # 选择引擎
    if args.engine == "audiodit":
        try:
            engine = LongCatAudioDiTEngine(model_dir=args.model_dir, device=args.device)
            print(f"[TTS] 使用 LongCat-AudioDiT 引擎 (device={args.device})")
        except Exception as e:
            print(f"[TTS] AudioDiT 初始化失败: {e}")
            print("[TTS] 回退到 Edge TTS")
            engine = EdgeTTSEngine(default_voice=args.voice)
    elif args.engine == "edge":
        engine = EdgeTTSEngine(default_voice=args.voice)
        print(f"[TTS] 使用 Edge TTS 引擎 (voice={engine._voice_name})")
    else:
        engine = WebSpeechFallback()
        print("[TTS] 使用 Web Speech 回退模式")

    cache = TTSCache()

    # CLI 单次推理模式
    if args.text:
        audio = engine.synthesize(args.text)
        with open(args.output, "wb") as f:
            f.write(audio)
        print(f"[TTS] 合成完成: {args.output} ({len(audio)} bytes)")
        return

    # HTTP 服务模式
    # Edge TTS 预热：后台建立连接，不阻塞服务启动
    if isinstance(engine, EdgeTTSEngine):
        engine.warmup()

    app = create_app(engine, cache)
    print(f"[TTS] 服务启动: http://{args.host}:{args.port}")
    print(f"[TTS] POST /tts  — 合成语音")
    print(f"[TTS] GET  /tts/health  — 健康检查")
    app.run(host=args.host, port=args.port, debug=False)


if __name__ == "__main__":
    main()
