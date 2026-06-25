"""
次元旅人 - 智能旅游规划意图解析器（Python 版本）

功能：
  - 读取用户自然语言输入（如 "我想悠闲地逛2小时，主要想看古建筑"）
  - 调用 OpenAI 兼容 LLM API 解析旅游意图
  - 返回结构化字典：duration_hours, pace, interests[], physical_level, must_see[], avoid[]
  - LLM 不可用时自动回退到正则表达式解析器

用法：
  python intent_parser.py --input "我想悠闲地逛2小时，主要想看古建筑"
  python intent_parser.py -i "我想悠闲地逛2小时，主要想看古建筑"

导出：
  parse_intent(user_input, config=None)  -- 主解析函数
  fallback_regex_parse(user_input)       -- 正则回退解析器
  load_config(override_config=None)      -- 配置加载工具

依赖：
  pip install requests
"""

import re
import os
import json
import argparse
import logging
from pathlib import Path
from typing import Dict, List, Optional, Any

# ---- 导入 requests（如未安装则标记为不可用，后续回退到正则解析器） ----
try:
    import requests as _requests
except ImportError:
    _requests = None
    print("[intent_parser] 警告：未安装 requests 库，LLM API 调用将不可用，将使用正则回退解析器。")
    print("[intent_parser] 安装方法：pip install requests")

# ---- 配置日志 ----
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(name)s] %(levelname)s: %(message)s'
)
logger = logging.getLogger('intent_parser')


# ============================================================
# 系统提示词（System Prompt）
# 指导 LLM 以结构化 JSON 格式输出旅游意图解析结果，含少样本示例
# ============================================================
SYSTEM_PROMPT = """你是一个旅游意图解析专家。请分析用户的旅游需求，输出JSON格式：

{
  "duration_hours": 数字（小时），
  "pace": "leisurely"|"moderate"|"fast",
  "interests": ["兴趣标签1", "兴趣标签2"],
  "physical_level": "low"|"medium"|"high",
  "must_see": ["必看景点"],
  "avoid": ["不想去的地方"],
  "scenic_area": "景区名称",
  "city": "所在城市"
}

字段说明：
- duration_hours：游览时长，单位为小时。若用户说"半天"则为4，"一天"则为8。
- pace：游览节奏。"leisurely"=悠闲漫步，"moderate"=正常节奏，"fast"=紧凑高效。
- interests：用户感兴趣的旅游类型标签，如"古建筑"、"美食"、"自然风光"、"历史文化"、"购物"、"亲子"等。
- physical_level：体力需求。"low"=适合老人小孩，"medium"=一般体力，"high"=需要较强体力。
- must_see：用户明确提到想看的景点列表，没有则为空数组。
- avoid：用户明确不想去的地方，没有则为空数组。
- scenic_area：用户提到的景区名称，未提及则为空字符串。
- city：用户提到的城市，未提及则为空字符串。

只输出JSON，不要输出其他内容。

示例1：
用户输入：我想悠闲地逛2小时，主要想看古建筑
输出：
{
  "duration_hours": 2,
  "pace": "leisurely",
  "interests": ["古建筑", "历史文化"],
  "physical_level": "low",
  "must_see": [],
  "avoid": [],
  "scenic_area": "",
  "city": ""
}

示例2：
用户输入：我带孩子在故宫玩半天，不想去人太多的地方，体力一般
输出：
{
  "duration_hours": 4,
  "pace": "moderate",
  "interests": ["亲子", "历史文化"],
  "physical_level": "medium",
  "must_see": ["故宫"],
  "avoid": ["人流密集区域"],
  "scenic_area": "故宫",
  "city": "北京"
}"""


# ============================================================
# 默认配置
# ============================================================
DEFAULT_CONFIG: Dict[str, Any] = {
    'endpoint':   'https://api.deepseek.com/v1/chat/completions',
    'api_key':    '',
    'model':      'deepseek-chat',
    'timeout':    15,      # 请求超时时间（秒）
    'max_tokens': 512      # 最大输出 token 数
}


# ============================================================
# 配置加载
# 优先级：环境变量 > 调用方传入 > config.json > 默认值
# ============================================================

def load_config(override_config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    加载并合并配置。

    配置查找顺序（高优先级覆盖低优先级）：
      1. 环境变量：LLM_ENDPOINT / LLM_API_KEY / LLM_MODEL
      2. override_config 参数（调用方传入）
      3. config.json 文件（父目录 > 当前目录）
      4. DEFAULT_CONFIG 内置默认值

    参数：
        override_config: 可选的覆盖配置字典

    返回：
        合并后的完整配置字典
    """
    override_config = override_config or {}

    # ---- 从 config.json 读取（优先查找父目录） ----
    file_config: Dict[str, Any] = {}
    script_dir = Path(__file__).parent.resolve()
    config_paths = [
        script_dir.parent / 'config.json',   # python/../config.json
        script_dir / 'config.json'            # python/config.json（备用）
    ]

    for config_path in config_paths:
        try:
            if config_path.exists():
                with open(config_path, 'r', encoding='utf-8') as f:
                    file_config = json.load(f)
                logger.info(f"已加载配置文件：{config_path}")
                break   # 找到第一个有效配置即停止
        except Exception as e:
            logger.warning(f"读取配置文件失败（{config_path}）：{e}")

    # ---- 合并配置（高优先级覆盖低优先级） ----
    config: Dict[str, Any] = {
        'endpoint': (
            os.environ.get('LLM_ENDPOINT')
            or override_config.get('endpoint')
            or file_config.get('llm_endpoint')
            or file_config.get('endpoint')
            or DEFAULT_CONFIG['endpoint']
        ),
        'api_key': (
            os.environ.get('LLM_API_KEY')
            or override_config.get('api_key')
            or file_config.get('llm_api_key')
            or file_config.get('api_key')
            or DEFAULT_CONFIG['api_key']
        ),
        'model': (
            os.environ.get('LLM_MODEL')
            or override_config.get('model')
            or file_config.get('llm_model')
            or file_config.get('model')
            or DEFAULT_CONFIG['model']
        ),
        'timeout': (
            override_config.get('timeout')
            or file_config.get('timeout')
            or DEFAULT_CONFIG['timeout']
        ),
        'max_tokens': (
            override_config.get('max_tokens')
            or file_config.get('max_tokens')
            or DEFAULT_CONFIG['max_tokens']
        )
    }

    return config


# ============================================================
# 正则表达式回退解析器
# 当 LLM API 不可用（无 Key、网络异常、超时等）时，使用简单规则匹配提取意图
# ============================================================

def fallback_regex_parse(user_input: str) -> Dict[str, Any]:
    """
    使用正则表达式和规则匹配从用户输入中提取旅游意图。
    作为 LLM 解析的降级方案，准确率有限但永不失败。

    参数：
        user_input: 用户自然语言输入

    返回：
        结构化意图字典
    """
    result: Dict[str, Any] = {
        'duration_hours':  0,
        'pace':            'moderate',
        'interests':       [],
        'physical_level':  'medium',
        'must_see':        [],
        'avoid':           [],
        'scenic_area':     '',
        'city':            ''
    }

    # ---- 解析游览时长 ----

    # 匹配 "X小时" / "X个小时"
    hour_match = re.search(r'(\d+(?:\.\d+)?)\s*(?:个)?\s*小时', user_input)
    if hour_match:
        result['duration_hours'] = float(hour_match.group(1))

    # 匹配 "半天" / "一天" / "X天"
    if re.search(r'半天', user_input):
        result['duration_hours'] = result['duration_hours'] or 4
    elif re.search(r'一天|一整天', user_input):
        result['duration_hours'] = result['duration_hours'] or 8
    else:
        day_match = re.search(r'(\d+(?:\.\d+)?)\s*天', user_input)
        if day_match:
            result['duration_hours'] = float(day_match.group(1)) * 8

    # ---- 解析游览节奏 ----
    # 悠闲类关键词 → leisurely + 低体力；紧凑类关键词 → fast + 高体力
    if re.search(r'悠闲|轻松|慢|慢慢|散心|不赶|随意', user_input):
        result['pace']          = 'leisurely'
        result['physical_level'] = 'low'
    elif re.search(r'紧凑|赶时间|快速|高效|时间紧', user_input):
        result['pace']          = 'fast'
        result['physical_level'] = 'high'

    # ---- 解析兴趣标签 ----
    # 关键词 → 兴趣类别的映射表
    interest_keywords = {
        '古建筑':   r'古建筑|古建|老建筑|古寺|古庙|寺庙|宫殿|古城',
        '自然风光': r'自然|风景|山水|湖|山|森林|瀑布|海边|海滩',
        '美食':     r'美食|吃|小吃|餐厅|特色菜|当地美食|火锅',
        '历史文化': r'历史|文化|博物馆|古迹|遗址|文化遗产',
        '购物':     r'购物|买|商场|集市|夜市|特产',
        '亲子':     r'孩子|儿童|亲子|家庭|带娃|小朋友',
        '摄影':     r'拍照|摄影|打卡|出片|网红',
        '夜游':     r'晚上|夜游|夜景|灯光秀'
    }

    for label, pattern in interest_keywords.items():
        if re.search(pattern, user_input):
            result['interests'].append(label)

    # ---- 解析必看景点 ----
    # 匹配"必看/一定要去/想看 + 景点名"的常见句式
    must_see_patterns = [
        r'(?<!不)(?:必看|一定要看|一定要去|想看|想去|必去)(?:的)?[：:\s]*([^\s,，。；;！!？?、]{1,10})',
        r'(?:重点|主要)(?:看|游览|参观)[：:\s]*([^\s,，。；;！!？?、]{1,10})'
    ]

    for pattern in must_see_patterns:
        for match in re.finditer(pattern, user_input):
            spot = match.group(1).strip()
            if spot and spot not in result['must_see']:
                result['must_see'].append(spot)

    # ---- 解析不想去的地方 ----
    avoid_patterns = [
        r'(?:不想去|不去|避免|讨厌|不喜欢)(?:的)?[：:\s]*([^\s,，。；;！!？?、]{1,10})'
    ]

    for pattern in avoid_patterns:
        for match in re.finditer(pattern, user_input):
            spot = match.group(1).strip()
            if spot and spot not in result['avoid']:
                result['avoid'].append(spot)

    # ---- 解析景区名称（匹配含特定后缀的地名） ----
    scenic_area_pattern = (
        r'(?:在|去|到|游览|逛)'
        r'([^\s,，。；;！!？?、]{2,10}(?:景区|公园|山|湖|古镇|古城|寺庙|博物馆|园林|遗址))'
    )
    scenic_match = re.search(scenic_area_pattern, user_input)
    if scenic_match:
        result['scenic_area'] = scenic_match.group(1).strip()

    # ---- 解析城市（匹配含"市/州"后缀的地名） ----
    city_pattern = r'(?:在|去|到)([^\s,，。；;！!？?、]{2,6}(?:市|州))'
    city_match = re.search(city_pattern, user_input)
    if city_match:
        result['city'] = city_match.group(1).strip()

    # ---- 兜底默认值 ----
    if result['duration_hours'] == 0:
        result['duration_hours'] = 3       # 未识别时长时默认 3 小时
    if not result['interests']:
        result['interests'].append('观光')  # 未识别兴趣时默认"观光"

    return result


# ============================================================
# LLM API 调用
# 向 OpenAI 兼容接口发送请求，返回原始文本响应
# ============================================================

def _call_llm(user_input: str, config: Dict[str, Any]) -> str:
    """
    调用 OpenAI 兼容的 LLM API（内部函数）。

    参数：
        user_input: 用户自然语言输入
        config:     配置字典（含 endpoint, api_key, model 等）

    返回：
        LLM 返回的原始文本内容

    抛出：
        RuntimeError: API Key 缺失、requests 未安装、HTTP 错误等
    """
    # 检查 requests 库是否可用
    if _requests is None:
        raise RuntimeError(
            '未安装 requests 库，无法调用 LLM API。请运行：pip install requests'
        )

    # 检查 API Key 是否已配置
    if not config.get('api_key'):
        raise RuntimeError(
            '未配置 LLM API Key，请在 config.json 或环境变量 LLM_API_KEY 中设置'
        )

    # 构造 OpenAI Chat Completions 请求体
    request_body = {
        'model':      config['model'],
        'messages':   [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user',   'content': user_input}
        ],
        'max_tokens':  config['max_tokens'],
        'temperature': 0.3    # 较低温度保证输出格式稳定
    }

    headers = {
        'Content-Type':  'application/json',
        'Authorization': f"Bearer {config['api_key']}"
    }

    # 发送 POST 请求
    response = _requests.post(
        config['endpoint'],
        json=request_body,
        headers=headers,
        timeout=config['timeout']
    )

    # 检查 HTTP 状态码
    if response.status_code != 200:
        raise RuntimeError(
            f'LLM API 返回错误，HTTP 状态码：{response.status_code}，'
            f'响应内容：{response.text[:200]}'
        )

    data = response.json()

    # 提取 LLM 返回的文本内容（OpenAI 标准响应结构）
    try:
        content = data['choices'][0]['message']['content']
    except (KeyError, IndexError):
        raise RuntimeError(
            f'LLM 响应结构异常，无法提取 content 字段。响应：{json.dumps(data, ensure_ascii=False)[:200]}'
        )

    if not content:
        raise RuntimeError('LLM 返回内容为空')

    return content


# ============================================================
# JSON 提取与清洗
# LLM 有时会在 JSON 外包裹 markdown 代码块（```json ... ```），需要清理后再解析
# ============================================================

def _extract_json(text: str) -> Dict[str, Any]:
    """
    从 LLM 输出文本中提取并解析 JSON 对象（内部函数）。
    支持去除 markdown 代码块包裹，以及从混合文本中提取第一个 JSON 对象。

    参数：
        text: LLM 返回的原始文本

    返回：
        解析后的字典

    抛出：
        ValueError: 无法提取有效 JSON 时抛出
    """
    cleaned = text.strip()

    # 去除 markdown 代码块包裹（```json ... ``` 或 ``` ... ```）
    cleaned = re.sub(r'^```(?:json)?\s*\n?', '', cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'\n?```\s*$', '', cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.strip()

    # 第一次尝试：直接解析整个清理后的文本
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # 第二次尝试：提取第一个完整的 JSON 对象（最外层 {} 对）
    brace_start = cleaned.find('{')
    brace_end   = cleaned.rfind('}')
    if brace_start != -1 and brace_end > brace_start:
        json_str = cleaned[brace_start:brace_end + 1]
        try:
            return json.loads(json_str)
        except json.JSONDecodeError:
            pass

    raise ValueError(f'无法从 LLM 输出中提取 JSON：{text[:200]}...')


# ============================================================
# 主函数：解析用户旅游意图
# 先尝试 LLM，失败时自动回退到正则解析器
# ============================================================

def parse_intent(user_input: str, config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    解析用户旅游意图的主入口函数。

    流程：
      1. 合并配置（环境变量 > 传入参数 > config.json > 默认值）
      2. 调用 LLM API 解析用户输入
      3. 若 LLM 调用失败（无 Key、网络异常、解析错误等），自动回退到正则解析器

    参数：
        user_input: 用户自然语言输入，如 "我想悠闲地逛2小时，主要想看古建筑"
        config:     可选配置字典，字段与 config.json 相同

    返回：
        结构化意图字典，包含以下字段：
          - duration_hours  (float)     游览时长（小时）
          - pace            (str)       "leisurely" | "moderate" | "fast"
          - interests       (list[str]) 兴趣标签列表
          - physical_level  (str)       "low" | "medium" | "high"
          - must_see        (list[str]) 必看景点列表
          - avoid           (list[str]) 不想去的地方列表
          - scenic_area     (str)       景区名称（未识别则为空字符串）
          - city            (str)       所在城市（未识别则为空字符串）

    抛出：
        ValueError: user_input 为空或非字符串时抛出
    """
    # 参数校验
    if not user_input or not isinstance(user_input, str):
        raise ValueError('用户输入不能为空，请提供自然语言描述')

    # 合并配置
    merged_config = load_config(config)

    logger.info(f'用户输入："{user_input}"')
    logger.info(f'使用模型：{merged_config["model"]}，接口：{merged_config["endpoint"]}')

    try:
        # 尝试调用 LLM API
        llm_output = _call_llm(user_input, merged_config)
        logger.info(f'LLM 原始输出：{llm_output}')

        # 从 LLM 输出中提取 JSON
        parsed = _extract_json(llm_output)

        # 补充缺失字段（使用安全默认值，保证返回结构完整）
        result: Dict[str, Any] = {
            'duration_hours':  parsed.get('duration_hours') or 3,
            'pace':            parsed.get('pace') or 'moderate',
            'interests':       parsed['interests'] if isinstance(parsed.get('interests'), list) else ['观光'],
            'physical_level':  parsed.get('physical_level') or 'medium',
            'must_see':        parsed['must_see']  if isinstance(parsed.get('must_see'), list)  else [],
            'avoid':           parsed['avoid']     if isinstance(parsed.get('avoid'), list)     else [],
            'scenic_area':     parsed.get('scenic_area') or '',
            'city':            parsed.get('city') or ''
        }

        logger.info('LLM 解析成功')
        return result

    except Exception as e:
        # LLM 调用失败，回退到正则解析器（保证功能可用）
        logger.warning(f'LLM 调用失败，回退到正则解析器。原因：{e}')

        fallback_result = fallback_regex_parse(user_input)
        logger.info(f'正则解析器结果：{json.dumps(fallback_result, ensure_ascii=False, indent=2)}')
        return fallback_result


# ============================================================
# CLI 入口
# 用法：python intent_parser.py --input "用户输入内容"
# ============================================================

def main() -> None:
    """
    命令行入口函数。
    使用 argparse 解析命令行参数，调用 parse_intent 并打印结果。
    """
    parser = argparse.ArgumentParser(
        description='次元旅人 - 旅游意图解析器（Python）',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例：
  python intent_parser.py --input "我想悠闲地逛2小时，主要想看古建筑"
  python intent_parser.py -i "带孩子在故宫玩半天，不想去人太多的地方"
  python intent_parser.py --input "快速游览西湖，重点看断桥和雷峰塔，不去购物中心"

环境变量：
  LLM_ENDPOINT  - LLM API 接口地址（默认：https://api.deepseek.com/v1/chat/completions）
  LLM_API_KEY   - LLM API 密钥（必填，否则回退到正则解析器）
  LLM_MODEL     - LLM 模型名称（默认：deepseek-chat）
        """
    )
    parser.add_argument(
        '--input', '-i',
        required=True,
        help='用户自然语言输入（如 "我想悠闲地逛2小时，主要想看古建筑"）'
    )

    args = parser.parse_args()

    try:
        result = parse_intent(args.input)
        print('\n===== 解析结果 =====')
        print(json.dumps(result, ensure_ascii=False, indent=2))
        print('====================')
    except Exception as e:
        logger.error(f'解析失败：{e}')
        raise SystemExit(1)


# ============================================================
# 模块启动入口
# ============================================================
if __name__ == '__main__':
    main()
