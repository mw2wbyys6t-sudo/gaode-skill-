#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
次元旅人 - 地图可视化生成器 (Python)

功能:
    1. 读取 interactive-map.html 模板
    2. 替换 __MAP_DATA__ 和 __AMAP_KEY__ 占位符
    3. 输出可直接在浏览器中打开的交互式地图 HTML 文件

CLI 用法:
    python map_visualizer.py --data route_result.json --output tour-map.html

模块导出:
    generate_map(route_result, output_path, config=None)
"""

import json
import os
import sys
import webbrowser
from pathlib import Path

# ========================================================
# 常量与默认配置
# ========================================================

# 模板文件路径（相对于本脚本所在目录的上级 templates 目录）
TEMPLATE_PATH = Path(__file__).resolve().parent.parent / "templates" / "interactive-map.html"

# 默认测试用 JSAPI Key（仅供开发调试，生产环境请替换为真实 Key）
DEFAULT_AMAP_KEY = "YOUR_AMAP_JSAPI_KEY"

# 配置文件路径
CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.json"


# ========================================================
# 工具函数
# ========================================================

def resolve_amap_key(config=None):
    """
    解析高德 JSAPI Key

    优先级:
        1. config 参数中传入的 amapJsapiKey
        2. 环境变量 AMAP_JSAPI_KEY
        3. config.json 中的 amapJsapiKey
        4. 默认测试 Key

    Args:
        config (dict, optional): 外部配置字典

    Returns:
        str: JSAPI Key
    """
    # 1. 外部直接传入
    if config and config.get("amapJsapiKey"):
        return config["amapJsapiKey"]

    # 2. 环境变量
    env_key = os.environ.get("AMAP_JSAPI_KEY")
    if env_key:
        return env_key

    # 3. 配置文件
    try:
        if CONFIG_PATH.exists():
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                file_config = json.load(f)
            if file_config.get("amapJsapiKey"):
                return file_config["amapJsapiKey"]
    except Exception as e:
        print(f"[次元旅人] 读取 config.json 失败: {e}", file=sys.stderr)

    # 4. 兜底默认值
    return DEFAULT_AMAP_KEY


def read_template():
    """
    读取 HTML 模板文件

    Returns:
        str: 模板内容

    Raises:
        FileNotFoundError: 模板文件不存在
    """
    if not TEMPLATE_PATH.exists():
        raise FileNotFoundError(f"模板文件不存在: {TEMPLATE_PATH}")

    with open(TEMPLATE_PATH, "r", encoding="utf-8") as f:
        return f.read()


# ========================================================
# 核心功能
# ========================================================

def generate_map(route_result, output_path, config=None):
    """
    生成地图 HTML 文件

    Args:
        route_result (dict): 路线规划结果数据，结构如下:
            {
                "scenic_name": "西湖",               # 景区名称
                "pois": [                            # POI 列表
                    {
                        "name": "断桥残雪",           # 景点名称
                        "lng": 120.153,              # 经度
                        "lat": 30.265,               # 纬度
                        "index": 1,                  # 序号（从 1 开始）
                        "duration_min": 30,          # 建议游览时长（分钟）
                        "tags": ["古建筑", "湖泊"],   # 标签
                        "address": "杭州市西湖区..."   # 地址
                    }
                ],
                "segments": [                        # 步行路段
                    {
                        "from_index": 0,             # 起点 POI 索引（0-based）
                        "to_index": 1,               # 终点 POI 索引（0-based）
                        "coords": [[lng, lat], ...], # 路线坐标
                        "walking_min": 8             # 步行时间（分钟）
                    }
                ],
                "total_duration_min": 120,           # 总游览时长（分钟）
                "total_walking_min": 25              # 总步行时长（分钟）
            }

        output_path (str): 输出 HTML 文件路径

        config (dict, optional): 可选配置
            - amapJsapiKey (str): 高德 JSAPI Key

    Returns:
        str: 生成的文件绝对路径

    Raises:
        ValueError: 参数无效
        FileNotFoundError: 模板文件不存在
    """
    # 参数校验
    if not route_result or not isinstance(route_result, dict):
        raise ValueError("route_result 参数无效，请传入路线规划结果字典")
    if not output_path:
        raise ValueError("output_path 参数无效，请指定输出文件路径")

    # 解析 JSAPI Key
    amap_key = resolve_amap_key(config)

    # 读取模板
    html = read_template()

    # 替换数据占位符 —— 将 __MAP_DATA__ 替换为 JSON 字符串
    data_json = json.dumps(route_result, ensure_ascii=False, indent=2)
    html = html.replace("__MAP_DATA__", data_json)

    # 替换 JSAPI Key 占位符
    html = html.replace("__AMAP_KEY__", amap_key)

    # 确保输出目录存在
    output = Path(output_path).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    # 写入文件
    with open(output, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"[次元旅人] 地图 HTML 已生成: {output}")
    return str(output)


def open_in_browser(file_path):
    """
    在默认浏览器中打开生成的 HTML 文件

    Args:
        file_path (str): HTML 文件路径
    """
    absolute_path = str(Path(file_path).resolve())
    try:
        webbrowser.open(f"file://{absolute_path}")
        print(f"[次元旅人] 已在浏览器中打开: {absolute_path}")
    except Exception as e:
        print(f"[次元旅人] 无法自动打开浏览器: {e}")
        print(f"[次元旅人] 请手动打开: {absolute_path}")


# ========================================================
# CLI 入口
# ========================================================

def parse_cli_args():
    """
    解析命令行参数
    支持格式: --data xxx --output xxx --key xxx --open

    Returns:
        dict: 参数字典
    """
    args = {}
    argv = sys.argv[1:]
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg.startswith("--"):
            key_value = arg[2:]

            # 处理 --key=value 格式
            if "=" in key_value:
                key, value = key_value.split("=", 1)
                args[key] = value
            else:
                key = key_value
                # 检查下一个参数是否为值（非 -- 开头）
                if i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                    args[key] = argv[i + 1]
                    i += 1
                else:
                    args[key] = True

        i += 1

    return args


def print_help():
    """打印帮助信息"""
    help_text = """
次元旅人 - 地图可视化生成器 (Python)

用法:
    python map_visualizer.py --data <路线数据JSON> --output <输出路径> [选项]

参数:
    --data      路线规划结果 JSON 文件路径（必填）
    --output    输出 HTML 文件路径（默认: tour-map.html）
    --key       高德 JSAPI Key（可选，也可通过环境变量 AMAP_JSAPI_KEY 设置）
    --open      生成后自动在浏览器中打开
    --help      显示此帮助信息

示例:
    python map_visualizer.py --data route_result.json --output tour-map.html --open
"""
    print(help_text)


def main():
    """CLI 主函数"""
    args = parse_cli_args()

    # 帮助信息
    if args.get("help") or args.get("h"):
        print_help()
        sys.exit(0)

    # 校验必填参数
    if "data" not in args:
        print("[次元旅人] 错误: 请通过 --data 参数指定路线数据 JSON 文件", file=sys.stderr)
        sys.exit(1)

    # 读取路线数据
    data_path = Path(args["data"]).resolve()
    if not data_path.exists():
        print(f"[次元旅人] 错误: 数据文件不存在: {data_path}", file=sys.stderr)
        sys.exit(1)

    try:
        with open(data_path, "r", encoding="utf-8") as f:
            route_result = json.load(f)
    except json.JSONDecodeError as e:
        print(f"[次元旅人] 错误: 解析 JSON 失败: {e}", file=sys.stderr)
        sys.exit(1)

    # 输出路径
    output_path = args.get("output", "tour-map.html")

    # 配置
    config = {}
    if args.get("key"):
        config["amapJsapiKey"] = args["key"]

    # 生成地图
    generated_path = generate_map(route_result, output_path, config)

    # 自动打开
    if args.get("open"):
        open_in_browser(generated_path)


# 当直接运行脚本时执行 CLI
if __name__ == "__main__":
    main()
