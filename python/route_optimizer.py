"""
次元旅人 - 智能旅游路线优化器 (Python 版)

核心算法流程:
    1. 过滤阶段 - 剔除不匹配用户偏好/体力限制的景点
    2. 评分阶段 - 综合计算每个景点的匹配分数
    3. 选择阶段 - 贪心选择，在时间预算内尽可能选高分景点
    4. 排序阶段 - 最近邻 TSP 启发式确定游览顺序
    5. 优化阶段 - 2-opt 局部搜索缩短步行总距离
    6. 路线生成 - 调用高德步行 API 获取真实路线
"""

import argparse
import json
import math
import os
import sys
from typing import Any, Dict, List, Optional

try:
    import requests
except ImportError:
    requests = None  # 没有 requests 时回退到 urllib

if requests is None:
    import urllib.request
    import urllib.error

# ========================== 常量 ==========================

EARTH_RADIUS_M = 6371000  # 地球平均半径（米）

# 高体力消耗标签，体力等级 low 时剔除
HEAVY_TAGS = {"爬山", "徒步", "攀岩", "登山", "hiking", "climbing"}

# 步行速度（米/分钟），根据体力等级调整
WALK_SPEEDS = {"low": 60, "medium": 80, "high": 100}


# ========================== 配置读取 ==========================


def load_config(config_path: Optional[str] = None) -> Dict[str, Any]:
    """
    读取高德 WebService Key，优先级:
        1. config.json 中的 amapWebServiceKey
        2. 环境变量 AMAP_WEBSERVICE_KEY
        3. 测试用 fallback key
    """
    config: Dict[str, Any] = {}

    # 尝试从脚本目录读取 config.json
    if config_path is None:
        config_path = os.path.join(os.path.dirname(__file__), "config.json")

    try:
        if os.path.exists(config_path):
            with open(config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
    except Exception:
        pass  # 忽略读取失败

    key = (
        config.get("amapWebServiceKey")
        or os.environ.get("AMAP_WEBSERVICE_KEY")
        or "f0f99d37a1379881c4d77d45d98b05a6"
    )

    return {**config, "amapWebServiceKey": key, "appName": "smart-tourism-planner"}


# ========================== 工具函数 ==========================


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Haversine 公式 - 估算两个经纬度点之间的直线距离（米）
    用于距离矩阵的快速估算，减少 API 调用次数
    """
    def to_rad(deg: float) -> float:
        return deg * math.pi / 180.0

    d_lat = to_rad(lat2 - lat1)
    d_lon = to_rad(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(to_rad(lat1)) * math.cos(to_rad(lat2)) * math.sin(d_lon / 2) ** 2
    )
    return 2 * EARTH_RADIUS_M * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _get_lon(poi: dict) -> float:
    """兼容 lon / lng 两种字段名"""
    return poi.get("lon", poi.get("lng", 0))


def _walk_speed(physical_level: str) -> float:
    """根据体力等级返回步行速度（米/分钟）"""
    return WALK_SPEEDS.get(physical_level, WALK_SPEEDS["medium"])


def _estimate_walk_minutes(dist_meters: float, physical_level: str) -> int:
    """
    根据 Haversine 距离估算步行时间（分钟）
    乘 1.3 的绕路系数，使估算更贴近真实步行路径
    """
    speed = _walk_speed(physical_level)
    return round((dist_meters * 1.3) / speed)


def _http_get_json(url: str, timeout: int = 8) -> Optional[dict]:
    """
    简易 HTTP GET 请求，返回 JSON dict 或 None
    优先使用 requests 库，不可用时回退到 urllib
    """
    if requests is not None:
        try:
            resp = requests.get(url, timeout=timeout)
            resp.raise_for_status()
            return resp.json()
        except Exception:
            return None
    else:
        # urllib 回退
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body)
        except Exception:
            return None


# ========================== 过滤阶段 ==========================


def filter_pois(pois: List[dict], preferences: dict) -> List[dict]:
    """
    过滤不符合用户兴趣和体力限制的 POI

    规则:
        - 如果用户指定了 interests，则 POI 的 tags 中至少要有一个匹配
        - 如果用户 physical_level 为 low，则剔除 tags 含高体力标签的 POI
        - suggested_duration <= 0 的 POI 直接剔除
    """
    if not pois:
        return []

    interests: List[str] = preferences.get("interests", [])
    physical_level: str = preferences.get("physical_level", "medium")

    result = []
    for poi in pois:
        # 游览时长无效的 POI 剔除
        duration = poi.get("suggested_duration", 0)
        if not duration or duration <= 0:
            continue

        # 兴趣标签匹配（用户未指定时不过滤）
        tags = poi.get("tags", [])
        if interests and tags:
            match = any(
                t == i or (isinstance(i, str) and isinstance(t, str) and (i in t or t in i))
                for t in tags
                for i in interests
            )
            if not match:
                continue

        # 体力限制过滤
        if physical_level == "low" and tags:
            if any(t in HEAVY_TAGS for t in tags):
                continue

        result.append(poi)

    return result


# ========================== 评分阶段 ==========================


def score_pois(pois: List[dict], preferences: dict) -> List[dict]:
    """
    综合评分 = 兴趣匹配(0.4) + 优先级(0.3) + 时间适配(0.3)

    interest_match: POI tags 与用户 interests 的重合度 (0~1)
    priority:       POI 自带优先级归一化 (0~1)，默认 0.5
    duration_fit:   POI 游览时长与剩余时间的契合度 (0~1)
    """
    interests: List[str] = preferences.get("interests", [])
    duration_hours: float = preferences.get("duration_hours", 4)
    total_minutes = duration_hours * 60

    scored = []
    for poi in pois:
        # --- 兴趣匹配分 ---
        interest_match = 0.5  # 默认中间值
        tags = poi.get("tags", [])
        if interests and tags:
            hits = sum(
                1 for t in tags
                if any(t == i or i in t or t in i for i in interests)
            )
            interest_match = hits / len(interests)

        # --- 优先级分 ---
        priority = min(max(poi.get("priority", 0.5), 0), 1)

        # --- 时间适配分 ---
        duration = poi.get("suggested_duration", 30)
        ratio = duration / total_minutes if total_minutes > 0 else 1.0
        if ratio <= 0.5:
            duration_fit = 1.0                          # 时长在预算一半以内，满分
        elif ratio <= 1.0:
            duration_fit = 1.0 - (ratio - 0.5) * 0.6   # 线性衰减到 0.7
        else:
            duration_fit = 0.3                          # 超出预算，低分但不完全排除

        score = interest_match * 0.4 + priority * 0.3 + duration_fit * 0.3
        scored.append({**poi, "_score": score, "_interestMatch": interest_match, "_durationFit": duration_fit})

    return scored


# ========================== 选择阶段 ==========================


def select_pois(scored_pois: List[dict], preferences: dict) -> List[dict]:
    """
    贪心选择 - 按分数从高到低，依次加入景点直到时间预算耗尽
    每次加入时累加: 游览时间 + 预估步行时间（与上一个选中景点之间）
    """
    duration_hours: float = preferences.get("duration_hours", 4)
    physical_level: str = preferences.get("physical_level", "medium")
    budget_minutes = duration_hours * 60

    # 按分数降序排列
    sorted_pois = sorted(scored_pois, key=lambda p: p["_score"], reverse=True)

    selected: List[dict] = []
    used_minutes = 0

    for poi in sorted_pois:
        # 估算与上一个选中景点之间的步行时间
        walk_min = 0
        if selected:
            last = selected[-1]
            dist = haversine(
                last["lat"], _get_lon(last),
                poi["lat"], _get_lon(poi),
            )
            walk_min = _estimate_walk_minutes(dist, physical_level)

        needed = poi.get("suggested_duration", 30) + walk_min
        if used_minutes + needed > budget_minutes:
            continue  # 放不下就跳过

        selected.append(poi)
        used_minutes += needed

    return selected


# ========================== 排序阶段 ==========================


def order_pois_nn(selected: List[dict]) -> List[dict]:
    """
    最近邻 TSP 启发式 - 从第一个选中的景点出发
    每步选离当前位置最近的未访问景点
    """
    if len(selected) <= 1:
        return selected

    remaining = list(selected)
    ordered = [remaining.pop(0)]  # 从第一个景点出发

    while remaining:
        current = ordered[-1]
        best_idx = 0
        best_dist = float("inf")

        for i, poi in enumerate(remaining):
            d = haversine(
                current["lat"], _get_lon(current),
                poi["lat"], _get_lon(poi),
            )
            if d < best_dist:
                best_dist = d
                best_idx = i

        ordered.append(remaining.pop(best_idx))

    return ordered


def _total_haversine_dist(ordered: List[dict]) -> float:
    """计算路线总 Haversine 距离（米）"""
    total = 0.0
    for i in range(len(ordered) - 1):
        total += haversine(
            ordered[i]["lat"], _get_lon(ordered[i]),
            ordered[i + 1]["lat"], _get_lon(ordered[i + 1]),
        )
    return total


# ========================== 优化阶段 ==========================


def two_opt_improve(ordered: List[dict], max_iter: int = 100) -> List[dict]:
    """
    2-opt 局部搜索 - 通过反复反转子路径来缩短总步行距离
    迭代直到无法找到更优的交换为止（最多 max_iter 轮防止死循环）
    """
    if len(ordered) < 3:
        return ordered

    best = list(ordered)
    improved = True
    iterations = 0

    while improved and iterations < max_iter:
        improved = False
        iterations += 1
        best_dist = _total_haversine_dist(best)

        for i in range(1, len(best) - 1):
            for j in range(i + 1, len(best)):
                # 反转 [i, j] 区间的子路径
                candidate = best[:i] + best[i : j + 1][::-1] + best[j + 1 :]
                cand_dist = _total_haversine_dist(candidate)
                if cand_dist < best_dist - 1:  # 至少改善 1 米才算有效
                    best = candidate
                    best_dist = cand_dist
                    improved = True

    return best


# ========================== 路线生成 ==========================


def _fallback_route(from_poi: dict, to_poi: dict, reason: str = "") -> dict:
    """
    回退路线 - API 不可用时使用 Haversine 距离估算
    """
    dist = haversine(
        from_poi["lat"], _get_lon(from_poi),
        to_poi["lat"], _get_lon(to_poi),
    )
    # 乘以 1.3 绕路系数估算实际步行距离
    est_meters = round(dist * 1.3)
    est_minutes = round(est_meters / 80)  # 按正常步行速度 80m/min

    return {
        "from": from_poi.get("name", ""),
        "to": to_poi.get("name", ""),
        "walking_minutes": est_minutes,
        "walking_meters": est_meters,
        "route_coords": [
            [_get_lon(from_poi), from_poi["lat"]],
            [_get_lon(to_poi), to_poi["lat"]],
        ],
        "_fallback": True,
        "_fallback_reason": reason or "未知原因",
    }


def fetch_walking_route(from_poi: dict, to_poi: dict, config: dict) -> dict:
    """
    调用高德步行路径规划 API 获取两点之间的实际步行路线
    文档: https://lbs.amap.com/api/webservice/guide/api/direction#t7

    返回: { from, to, walking_minutes, walking_meters, route_coords }
    API 失败时回退到 Haversine 估算
    """
    key = config["amapWebServiceKey"]
    origin = f"{_get_lon(from_poi)},{from_poi['lat']}"
    destination = f"{_get_lon(to_poi)},{to_poi['lat']}"

    url = (
        "https://restapi.amap.com/v3/direction/walking"
        f"?key={key}"
        f"&origin={origin}"
        f"&destination={destination}"
        f"&output=JSON"
        f"&appname={config['appName']}"
    )

    data = _http_get_json(url)

    # API 返回异常检查
    if (
        data is None
        or data.get("status") != "1"
        or not data.get("route")
        or not data["route"].get("paths")
    ):
        return _fallback_route(from_poi, to_poi, "API 返回异常或请求失败")

    path = data["route"]["paths"][0]
    try:
        dist_meters = int(path.get("distance", 0))
        duration_sec = int(path.get("duration", 0))
        walking_minutes = round(duration_sec / 60)
    except (ValueError, TypeError):
        return _fallback_route(from_poi, to_poi, "API 返回数据格式异常")

    # 提取路线坐标 [[lng, lat], ...]
    route_coords: List[List[float]] = []
    for step in path.get("steps", []):
        polyline = step.get("polyline", "")
        if polyline:
            for pair in polyline.split(";"):
                parts = pair.split(",")
                if len(parts) == 2:
                    try:
                        lng, lat = float(parts[0]), float(parts[1])
                        route_coords.append([lng, lat])
                    except ValueError:
                        continue

    return {
        "from": from_poi.get("name", ""),
        "to": to_poi.get("name", ""),
        "walking_minutes": walking_minutes,
        "walking_meters": dist_meters,
        "route_coords": route_coords,
    }


# ========================== 主函数 ==========================


def _clean_poi(poi: dict) -> dict:
    """清理 POI 对象，移除内部评分字段"""
    return {k: v for k, v in poi.items() if not k.startswith("_")}


def optimize_route(
    pois: List[dict],
    preferences: Optional[dict] = None,
    config: Optional[dict] = None,
) -> dict:
    """
    智能路线优化主入口

    Args:
        pois:        候选景点列表
                     [{ name, lat, lon, suggested_duration, priority, tags }]
        preferences: 用户偏好
                     { duration_hours, pace, interests, physical_level }
        config:      可选配置 { amapWebServiceKey }

    Returns:
        优化后的路线结果 dict
    """
    # --- 边界情况: 无输入 ---
    if not pois:
        return {
            "ordered_pois": [],
            "total_duration_minutes": 0,
            "total_walking_minutes": 0,
            "total_walking_meters": 0,
            "segments": [],
        }

    # 加载或合并配置
    cfg = load_config()
    if config:
        cfg.update(config)

    prefs = {
        "duration_hours": 4,
        "pace": "medium",
        "interests": [],
        "physical_level": "medium",
        **(preferences or {}),
    }

    # ===== 阶段 1: 过滤 =====
    filtered = filter_pois(pois, prefs)

    # 全部被过滤的边界情况
    if not filtered:
        return {
            "ordered_pois": [],
            "total_duration_minutes": 0,
            "total_walking_minutes": 0,
            "total_walking_meters": 0,
            "segments": [],
            "_warning": "所有景点均被过滤，请检查兴趣标签或体力等级设置",
        }

    # ===== 阶段 2: 评分 =====
    scored = score_pois(filtered, prefs)

    # ===== 阶段 3: 贪心选择 =====
    selected = select_pois(scored, prefs)

    # 只选中了 1 个景点的边界情况
    if len(selected) == 1:
        poi = selected[0]
        return {
            "ordered_pois": [_clean_poi(poi)],
            "total_duration_minutes": poi.get("suggested_duration", 0),
            "total_walking_minutes": 0,
            "total_walking_meters": 0,
            "segments": [],
        }

    # ===== 阶段 4: 最近邻排序 =====
    ordered = order_pois_nn(selected)

    # ===== 阶段 5: 2-opt 优化 =====
    ordered = two_opt_improve(ordered)

    # ===== 阶段 6: 调用高德步行 API 生成实际路线 =====
    segments: List[dict] = []
    total_walk_min = 0
    total_walk_m = 0

    for i in range(len(ordered) - 1):
        seg = fetch_walking_route(ordered[i], ordered[i + 1], cfg)
        segments.append(seg)
        total_walk_min += seg["walking_minutes"]
        total_walk_m += seg["walking_meters"]

    # 计算总游览时长（含步行）
    total_visit_min = sum(p.get("suggested_duration", 0) for p in ordered)
    total_duration = total_visit_min + total_walk_min

    return {
        "ordered_pois": [_clean_poi(p) for p in ordered],
        "total_duration_minutes": total_duration,
        "total_walking_minutes": total_walk_min,
        "total_walking_meters": total_walk_m,
        "segments": segments,
    }


# ========================== CLI 入口 ==========================


def main():
    """
    命令行用法:
        python route_optimizer.py --pois pois.json --preferences prefs.json

    支持文件路径和内联 JSON 两种方式:
        --pois pois.json                  (从文件读取)
        --pois '[{"name":"断桥残雪",...}]' (内联 JSON)
    """
    parser = argparse.ArgumentParser(description="次元旅人 - 智能旅游路线优化器")
    parser.add_argument("--pois", required=True, help="景点数据 JSON 文件路径或内联 JSON 字符串")
    parser.add_argument("--preferences", default="{}", help="用户偏好 JSON 文件路径或内联 JSON 字符串")

    args = parser.parse_args()

    # --- 解析 POIs ---
    def load_json_arg(value: str) -> Any:
        """先尝试当文件路径读取，再尝试内联 JSON"""
        try:
            with open(value, "r", encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, IsADirectoryError):
            pass
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            print(f"错误: 无法解析参数 '{value}'，请提供有效的 JSON 文件路径或内联 JSON", file=sys.stderr)
            sys.exit(1)

    pois = load_json_arg(args.pois)
    preferences = load_json_arg(args.preferences)

    # --- 执行优化 ---
    result = optimize_route(pois, preferences)

    # --- 输出结果 ---
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
