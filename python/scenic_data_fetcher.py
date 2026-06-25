# -*- coding: utf-8 -*-
"""
次元旅人 - 智能旅游规划器
景区 POI 数据抓取模块 (Python)

功能：
  - 根据景区名称和城市，从高德 Web Service API 获取 POI 数据
  - 支持中国大陆（restapi.amap.com）和海外（sg-restapi.opnavi.com）两套端点
  - 对 POI 数据进行增强：建议游览时长、标签、优先级评分
  - 支持加载本地 JSON 知识库文件，本地数据优先级高于 API 返回
  - 发送遥测日志

CLI 用法：
  python scenic_data_fetcher.py --scenic 西湖 --city 杭州

模块导出：
  fetch_scenic_pois(scenic_name, city, options=None) -> list[dict]
"""

import argparse
import json
import math
import os
import threading
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

# ---------------------------------------------------------------------------
# 常量 & 默认配置
# ---------------------------------------------------------------------------

# 内置测试 Key（仅用于开发调试）
BUILTIN_TEST_KEY = "f0f99d37a1379881c4d77d45d98b05a6"

# 高德 Web Service API 端点
API_ENDPOINTS = {
    "mainland": "https://restapi.amap.com/v5/place/text",
    "overseas": "https://sg-restapi.opnavi.com/v3/place/text",
}

# 遥测日志端点
TELEMETRY_URL = "https://restapi.amap.com/v3/log/init"

# 搜索类型过滤
SEARCH_TYPES = "风景名胜|旅游景点"

# 应用名称，所有 API 请求都会带上
APP_NAME = "smart-tourism-planner"

# POI 类型 → 建议游览时长映射（分钟）
# 每条规则包含关键词列表和时长区间 [min, max]
TYPE_DURATION_MAP = [
    {"keywords": ["风景名胜", "公园", "广场", "景区"], "min": 45, "max": 90},
    {"keywords": ["博物馆", "纪念馆", "展览馆", "艺术馆"], "min": 60, "max": 120},
    {"keywords": ["寺庙", "古建筑", "古迹", "遗址", "古镇"], "min": 30, "max": 60},
    {"keywords": ["餐饮", "美食", "餐厅", "小吃"], "min": 30, "max": 60},
    {"keywords": ["购物", "商场", "市场", "商店"], "min": 30, "max": 60},
]

# 默认建议游览时长（分钟）
DEFAULT_DURATION = 30


# ---------------------------------------------------------------------------
# 配置读取
# ---------------------------------------------------------------------------


def resolve_api_key(options: Optional[Dict[str, Any]] = None) -> str:
    """
    解析高德 Web Service Key
    优先级：options["api_key"] > 环境变量 AMAP_WEBSERVICE_KEY > config.json > 内置测试 Key

    Args:
        options: 可选配置字典

    Returns:
        解析到的 API Key 字符串
    """
    options = options or {}

    # 1. 直接传入
    if options.get("api_key"):
        return options["api_key"]

    # 2. 环境变量
    env_key = os.environ.get("AMAP_WEBSERVICE_KEY")
    if env_key:
        return env_key

    # 3. config.json（沿当前文件向上查找）
    current_dir = Path(__file__).resolve().parent
    config_search_dirs = [
        current_dir.parent / "config.json",  # python/../config.json
        current_dir / "config.json",  # python/config.json
    ]

    for cfg_path in config_search_dirs:
        try:
            if cfg_path.exists():
                with open(cfg_path, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                key = cfg.get("amapWebServiceKey")
                if key:
                    return key
        except Exception as e:
            print(f"[配置] 读取 {cfg_path} 失败: {e}", file=sys.stderr)

    # 4. 内置测试 Key
    print("[配置] 未找到 API Key，使用内置测试 Key（仅供调试）", file=sys.stderr)
    return BUILTIN_TEST_KEY


# ---------------------------------------------------------------------------
# 遥测
# ---------------------------------------------------------------------------


def send_telemetry() -> None:
    """
    发送遥测日志到高德（在后台线程中执行，不阻塞主流程）
    """

    def _send():
        try:
            url = f"{TELEMETRY_URL}?appname={APP_NAME}"
            requests.get(url, timeout=3)
        except Exception:
            # 遥测失败不影响主流程
            pass

    t = threading.Thread(target=_send, daemon=True)
    t.start()


# ---------------------------------------------------------------------------
# POI 数据增强
# ---------------------------------------------------------------------------


def infer_suggested_duration(poi_type: str) -> int:
    """
    根据 POI 的 type 字段推断建议游览时长

    Args:
        poi_type: 高德返回的 POI type 字符串

    Returns:
        建议游览时长（分钟），取区间中值
    """
    if not poi_type:
        return DEFAULT_DURATION

    for rule in TYPE_DURATION_MAP:
        if any(kw in poi_type for kw in rule["keywords"]):
            # 返回区间中值作为建议时长
            return round((rule["min"] + rule["max"]) / 2)

    return DEFAULT_DURATION


def generate_tags(raw_poi: Dict[str, Any]) -> List[str]:
    """
    根据 POI 类型和名称生成标签

    Args:
        raw_poi: 高德原始 POI 数据字典

    Returns:
        标签字符串列表
    """
    tags: List[str] = []

    # 从 type 中提取主标签
    poi_type = raw_poi.get("type", "")
    if poi_type:
        for part in poi_type.split(";"):
            trimmed = part.strip()
            if trimmed:
                tags.append(trimmed)

    # 如果有 biz_ext 中的 tag，也加入
    biz_ext = raw_poi.get("biz_ext") or {}
    ext_tag = biz_ext.get("tag")
    if ext_tag:
        ext_tags = ext_tag if isinstance(ext_tag, list) else [ext_tag]
        for t in ext_tags:
            if t and t not in tags:
                tags.append(t)

    # 特殊标签推断
    name = raw_poi.get("name", "")
    if name:
        if "世界遗产" in name or "世遗" in name:
            tags.append("世界遗产")
        rating = biz_ext.get("rating", "")
        if "5A" in name or rating == "5A":
            if "5A景区" not in tags:
                tags.append("5A景区")
        if "4A" in name or rating == "4A":
            if "4A景区" not in tags:
                tags.append("4A景区")

    return tags if tags else ["景点"]


def calculate_priority(raw_poi: Dict[str, Any]) -> int:
    """
    计算 POI 优先级评分（0-100）
    评分依据：类型权重 + 评分加成 + 景区等级

    Args:
        raw_poi: 高德原始 POI 数据字典

    Returns:
        优先级评分（0-100）
    """
    score = 50.0  # 基础分

    # 风景名胜类型加分
    poi_type = raw_poi.get("type", "")
    if poi_type:
        if "风景名胜" in poi_type:
            score += 20
        elif "旅游景点" in poi_type:
            score += 15
        elif "博物馆" in poi_type:
            score += 15
        elif "公园" in poi_type:
            score += 10

    # 用户评分加成
    biz_ext = raw_poi.get("biz_ext") or {}
    rating_str = biz_ext.get("rating", "")
    if rating_str:
        try:
            rating = float(rating_str)
            score += min(rating * 3, 15)  # 最高加 15 分
        except (ValueError, TypeError):
            pass

    # 5A/4A 景区加成
    if rating_str == "5A":
        score += 10
    elif rating_str == "4A":
        score += 5

    # 有图片的 POI 稍微加分（信息更丰富）
    images = raw_poi.get("images")
    if images and len(images) > 0:
        score += 3

    return min(round(score), 100)


def enrich_poi(raw_poi: Dict[str, Any]) -> Dict[str, Any]:
    """
    将高德原始 POI 数据转换为增强后的结构化对象

    Args:
        raw_poi: 高德 API 返回的单条 POI 字典

    Returns:
        增强后的 POI 字典
    """
    # 解析经纬度
    lng: Optional[float] = None
    lat: Optional[float] = None
    location_str = raw_poi.get("location", "")
    if location_str:
        parts = location_str.split(",")
        if len(parts) == 2:
            try:
                lng = float(parts[0])
                lat = float(parts[1])
            except (ValueError, TypeError):
                pass

    biz_ext = raw_poi.get("biz_ext") or {}

    return {
        "name": raw_poi.get("name", ""),
        "address": raw_poi.get("address", ""),
        "location": {"lng": lng, "lat": lat},
        "type": raw_poi.get("type", "未知"),
        "tags": generate_tags(raw_poi),
        "suggested_duration_minutes": infer_suggested_duration(raw_poi.get("type", "")),
        "priority": calculate_priority(raw_poi),
        "description": biz_ext.get("description", ""),
        # 保留原始 ID，方便调试
        "_amap_id": raw_poi.get("id"),
        "_tel": raw_poi.get("tel"),
    }


# ---------------------------------------------------------------------------
# 本地知识库加载
# ---------------------------------------------------------------------------


def load_local_knowledge(
    scenic_name: str, options: Optional[Dict[str, Any]] = None
) -> List[Dict[str, Any]]:
    """
    加载本地 JSON 知识库文件
    知识库文件应放在 knowledge/ 目录下，文件名建议为 <景区名>.json
    格式：{ "pois": [ { name, address, location: {lng, lat}, type, tags, ... } ] }

    Args:
        scenic_name: 景区名称
        options: 配置选项

    Returns:
        本地 POI 列表，若无文件则返回空列表
    """
    options = options or {}
    current_dir = Path(__file__).resolve().parent

    knowledge_dirs = []
    if options.get("knowledge_dir"):
        knowledge_dirs.append(Path(options["knowledge_dir"]))
    knowledge_dirs.append(current_dir.parent / "knowledge")
    knowledge_dirs.append(current_dir / "knowledge")

    for dir_path in knowledge_dirs:
        # 尝试多种文件名匹配
        candidates = [
            f"{scenic_name}.json",
            f"{scenic_name.replace(' ', '_')}.json",
            "pois.json",
        ]

        for filename in candidates:
            file_path = dir_path / filename
            try:
                if file_path.exists():
                    with open(file_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    pois = data if isinstance(data, list) else data.get("pois", [])
                    print(f"[知识库] 已加载本地数据: {file_path} ({len(pois)} 条)")
                    return pois
            except Exception as e:
                print(f"[知识库] 读取 {file_path} 失败: {e}", file=sys.stderr)

    return []


def merge_pois(
    api_pois: List[Dict[str, Any]], local_pois: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    合并本地知识库与 API 数据
    本地数据优先级高于 API 返回（按 name 匹配，本地覆盖 API）

    Args:
        api_pois: API 返回并增强后的 POI 列表
        local_pois: 本地知识库 POI 列表

    Returns:
        合并后的 POI 列表（按优先级降序排列）
    """
    if not local_pois:
        return api_pois

    # 建立已见名称集合
    seen: set = set()
    merged: List[Dict[str, Any]] = []

    # 先加入本地数据（高优先级）
    for poi in local_pois:
        # 如果已经是增强格式则直接使用，否则进行增强
        enriched = poi if "suggested_duration_minutes" in poi else enrich_poi(poi)
        merged.append(enriched)
        name = poi.get("name")
        if name:
            seen.add(name)

    # 再加入 API 中未被覆盖的数据
    for poi in api_pois:
        name = poi.get("name")
        if name not in seen:
            merged.append(poi)
            if name:
                seen.add(name)

    # 按优先级降序排列
    merged.sort(key=lambda p: p.get("priority", 0), reverse=True)

    return merged


# ---------------------------------------------------------------------------
# 核心 API 调用
# ---------------------------------------------------------------------------


def resolve_region(options: Optional[Dict[str, Any]] = None) -> str:
    """
    判断景区是否属于海外（非中国大陆）
    简单规则：如果 options["region"] 显式指定为 'overseas'，则使用海外端点

    Args:
        options: 配置选项

    Returns:
        'mainland' 或 'overseas'
    """
    options = options or {}
    if options.get("region") == "overseas":
        return "overseas"
    return "mainland"


def fetch_from_amap(
    scenic_name: str,
    city: str,
    api_key: str,
    options: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """
    从高德 Web Service API 搜索景区 POI

    Args:
        scenic_name: 景区名称（如 "西湖"）
        city: 城市名称（如 "杭州"）
        api_key: 高德 API Key
        options: 配置选项

    Returns:
        增强后的 POI 列表
    """
    options = options or {}
    region = resolve_region(options)
    base_url = API_ENDPOINTS[region]

    # 构建请求参数
    params = {
        "key": api_key,
        "keywords": scenic_name,
        "city": city,
        "types": SEARCH_TYPES,
        "offset": options.get("page_size", 25),
        "page": 1,
        "appname": APP_NAME,
        "output": "JSON",
    }

    # 海外端点使用 v3，参数格式略有不同
    if region == "overseas":
        del params["types"]  # v3 端点用 keyword 即可

    print(f"[API] 请求高德 {region} 端点: {base_url}")
    print(f'[API] 搜索: keywords="{scenic_name}", city="{city}"')

    try:
        response = requests.get(
            base_url,
            params=params,
            timeout=options.get("timeout", 10),
            headers={"User-Agent": f"{APP_NAME}/1.0"},
        )
        response.raise_for_status()
        data = response.json()

        # 检查返回状态
        status = data.get("status")
        if str(status) != "1":
            err_info = data.get("info") or data.get("infocode") or "未知错误"
            print(
                f"[API] 高德返回错误: status={status}, info={err_info}",
                file=sys.stderr,
            )
            return []

        raw_pois = data.get("pois", [])
        print(f"[API] 获取到 {len(raw_pois)} 条 POI 数据")

        # 增强每条 POI 数据
        return [enrich_poi(poi) for poi in raw_pois]

    except requests.exceptions.Timeout:
        print("[API] 请求超时，请检查网络连接", file=sys.stderr)
        return []
    except requests.exceptions.HTTPError as e:
        print(f"[API] HTTP 错误: {e}", file=sys.stderr)
        return []
    except requests.exceptions.RequestException as e:
        print(f"[API] 请求失败: {e}", file=sys.stderr)
        return []
    except (json.JSONDecodeError, ValueError) as e:
        print(f"[API] 解析响应失败: {e}", file=sys.stderr)
        return []


# ---------------------------------------------------------------------------
# 主入口函数
# ---------------------------------------------------------------------------


def fetch_scenic_pois(
    scenic_name: str,
    city: str,
    options: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """
    获取景区 POI 数据（主入口）

    流程：
      1. 发送遥测日志
      2. 调用高德 API 获取 POI
      3. 加载本地知识库
      4. 合并数据（本地优先）
      5. 返回增强后的 POI 列表

    Args:
        scenic_name: 景区名称，如 "西湖"、"故宫"
        city: 城市名称，如 "杭州"、"北京"
        options: 配置选项字典，支持以下键：
            - api_key (str): 高德 Web Service API Key
            - region (str): 'mainland'（默认）或 'overseas'
            - page_size (int): 每页返回数量，默认 25
            - timeout (int): 请求超时时间（秒），默认 10
            - knowledge_dir (str): 本地知识库目录路径
            - skip_telemetry (bool): 是否跳过遥测，默认 False

    Returns:
        增强后的 POI 对象列表，每个对象结构如下：
        {
            "name": str,                       # POI 名称
            "address": str,                    # 地址
            "location": {"lng": float, "lat": float},  # 经纬度
            "type": str,                       # 类型
            "tags": list[str],                 # 标签数组
            "suggested_duration_minutes": int, # 建议游览时长（分钟）
            "priority": int,                   # 优先级评分（0-100）
            "description": str,                # 描述
            "_amap_id": str | None,            # 高德原始 ID
            "_tel": str | None,                # 电话
        }

    Raises:
        ValueError: 当 scenic_name 或 city 为空时
    """
    options = options or {}

    if not scenic_name:
        raise ValueError("景区名称 (scenic_name) 不能为空")
    if not city:
        raise ValueError("城市名称 (city) 不能为空")

    print(f"\n========================================")
    print(f"  次元旅人 - 景区 POI 数据抓取")
    print(f"  景区: {scenic_name}  城市: {city}")
    print(f"========================================\n")

    # 1. 发送遥测（后台线程，不阻塞）
    if not options.get("skip_telemetry"):
        send_telemetry()

    # 2. 解析 API Key
    api_key = resolve_api_key(options)

    # 3. 调用高德 API
    api_pois = fetch_from_amap(scenic_name, city, api_key, options)

    # 4. 加载本地知识库
    local_pois = load_local_knowledge(scenic_name, options)

    # 5. 合并数据（本地知识库优先）
    merged = merge_pois(api_pois, local_pois)

    print(
        f"\n[结果] 共 {len(merged)} 条 POI"
        f"（API: {len(api_pois)}, 本地: {len(local_pois)}）"
    )

    return merged


# ---------------------------------------------------------------------------
# CLI 入口
# ---------------------------------------------------------------------------


def main():
    """命令行入口"""
    parser = argparse.ArgumentParser(
        description="次元旅人 - 景区 POI 数据抓取工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python scenic_data_fetcher.py --scenic 西湖 --city 杭州
  python scenic_data_fetcher.py --scenic 故宫 --city 北京 --region mainland
  python scenic_data_fetcher.py --scenic 富士山 --city 东京 --region overseas
        """,
    )

    parser.add_argument(
        "--scenic",
        required=True,
        help="景区名称（必填），如：西湖、故宫、迪士尼",
    )
    parser.add_argument(
        "--city",
        required=True,
        help="城市名称（必填），如：杭州、北京、上海",
    )
    parser.add_argument(
        "--region",
        choices=["mainland", "overseas"],
        default="mainland",
        help="API 区域：mainland（中国大陆，默认）或 overseas（海外）",
    )
    parser.add_argument(
        "--key",
        default=None,
        help="高德 Web Service API Key（可选，也可通过环境变量或 config.json 配置）",
    )
    parser.add_argument(
        "--page-size",
        type=int,
        default=25,
        help="每页返回 POI 数量（默认 25）",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=10,
        help="请求超时时间，单位秒（默认 10）",
    )
    parser.add_argument(
        "--knowledge-dir",
        default=None,
        help="本地知识库目录路径（可选）",
    )
    parser.add_argument(
        "--output",
        choices=["json", "pretty"],
        default="pretty",
        help="输出格式：json（纯 JSON）或 pretty（格式化输出，默认）",
    )

    args = parser.parse_args()

    # 构建 options
    options = {
        "region": args.region,
        "page_size": args.page_size,
        "timeout": args.timeout,
    }
    if args.key:
        options["api_key"] = args.key
    if args.knowledge_dir:
        options["knowledge_dir"] = args.knowledge_dir

    try:
        pois = fetch_scenic_pois(args.scenic, args.city, options)

        print("\n--- POI 数据 (JSON) ---\n")

        if args.output == "json":
            print(json.dumps(pois, ensure_ascii=False))
        else:
            print(json.dumps(pois, ensure_ascii=False, indent=2))

    except Exception as e:
        print(f"\n执行失败: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
