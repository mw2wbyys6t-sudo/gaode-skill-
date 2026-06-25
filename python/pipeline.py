#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
次元旅人 - 智能旅游规划全流程管线（Python 入口）

将四个阶段串联为端到端流水线：
  阶段 1：意图解析      → intent_parser.py      → parse_intent()
  阶段 2：景区数据抓取   → scenic_data_fetcher.py → fetch_scenic_pois()
  阶段 3：路线优化       → route_optimizer.py     → optimize_route()
  阶段 4：地图可视化     → map_visualizer.py      → generate_map()

CLI 用法：
  python pipeline.py --input "我想悠闲地逛西湖2小时，主要想看古建筑和自然风光"
  python pipeline.py --input "逛西湖2小时" --city 杭州 --output my-tour.html --open

可选参数：
  --input   用户自然语言输入（必填）
  --city    城市名称（可选，可从意图中推断）
  --output  输出 HTML 文件路径（默认 tour-map.html）
  --open    完成后自动在浏览器中打开

模块导出：
  run_pipeline(user_input, options=None)
"""

import argparse
import json
import os
import sys
import traceback
import webbrowser
from pathlib import Path
from typing import Any, Dict, Optional

# ---------- 导入四个阶段的子模块 ----------
# 支持两种导入方式：
#   1. 作为包内模块：from . import ...（需要 __init__.py）
#   2. 作为独立脚本：通过 sys.path 添加当前目录后直接 import

_HERE = Path(__file__).resolve().parent

try:
    # 尝试相对导入（作为包使用时）
    from . import intent_parser
    from . import scenic_data_fetcher
    from . import route_optimizer
    from . import map_visualizer
except ImportError:
    # 回退：将脚本所在目录加入 sys.path，支持直接 python pipeline.py 运行
    if str(_HERE) not in sys.path:
        sys.path.insert(0, str(_HERE))
    import intent_parser        # noqa: E402
    import scenic_data_fetcher  # noqa: E402
    import route_optimizer      # noqa: E402
    import map_visualizer      # noqa: E402


# ---------- 配置加载 ----------

def _load_shared_config() -> Dict[str, Any]:
    """
    加载共享配置文件 config.json（位于 python/ 目录）。
    若文件不存在则返回空字典，各模块会使用各自默认值。
    """
    config_path = _HERE / 'config.json'
    try:
        if config_path.exists():
            with open(config_path, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception as e:
        print(f'⚠️  读取 config.json 失败，将使用默认配置: {e}')
    return {}


# ---------- 辅助函数 ----------

def _extract_scenic_name(intent: Dict[str, Any]) -> str:
    """
    从意图解析结果中推断景区名称。
    优先使用 must_see 中的第一个景点，否则返回 scenic_name / location 字段。
    """
    must_see = intent.get('must_see') or []
    if must_see:
        return must_see[0]
    return intent.get('scenic_name', '') or intent.get('location', '') or ''


def _format_duration(minutes) -> str:
    """格式化时长（分钟 → "X小时Y分钟"）"""
    if minutes is None:
        return '未知'
    minutes = int(round(minutes))
    h = minutes // 60
    m = minutes % 60
    if h > 0 and m > 0:
        return f'{h}小时{m}分钟'
    if h > 0:
        return f'{h}小时'
    return f'{m}分钟'


# ---------- 核心管线 ----------

def run_pipeline(user_input: str, options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    执行完整的旅游规划管线。

    参数：
        user_input: 用户自然语言输入
        options:    可选配置字典
                    - city:   城市名称（可选）
                    - output: 输出 HTML 路径（默认 tour-map.html）
                    - open:   是否自动在浏览器中打开（默认 False）

    返回：
        包含各阶段结果的汇总字典
    """
    if not user_input or not isinstance(user_input, str):
        raise ValueError('缺少用户输入，请使用 --input 参数提供自然语言描述。')

    if options is None:
        options = {}

    config      = _load_shared_config()
    output_path = options.get('output', 'tour-map.html')

    # ============================================================
    # 阶段 1：意图解析
    # ============================================================
    print('\n🔍 阶段一：意图解析...')
    try:
        intent = intent_parser.parse_intent(user_input, config)
        duration_h = intent.get('duration_hours', '?')
        pace       = intent.get('pace', '?')
        interests  = ', '.join(intent.get('interests', [])) or '无'
        print('   ✔ 意图解析完成')
        print(f'     时长: {duration_h}小时 | 节奏: {pace} | 兴趣: {interests}')
    except Exception as e:
        print(f'   ✘ 意图解析失败: {e}')
        raise RuntimeError(f'阶段一（意图解析）出错: {e}') from e

    # ============================================================
    # 阶段 2：景区数据抓取
    # ============================================================
    print('\n📍 阶段二：获取景区数据...')
    scenic_name = _extract_scenic_name(intent)
    city        = options.get('city') or intent.get('city', '') or ''

    if not scenic_name:
        raise RuntimeError(
            '阶段二（景区数据抓取）出错：无法从意图中推断景区名称，'
            '请使用更具体的描述或通过 --city 指定。'
        )
    print(f'   景区: {scenic_name}{" | 城市: " + city if city else ""}')

    try:
        pois = scenic_data_fetcher.fetch_scenic_pois(
            scenic_name, city,
            options={'config': config, 'intent': intent},
        )
        poi_count = len(pois) if pois else 0
        print(f'   ✔ 获取到 {poi_count} 个 POI 数据点')
    except Exception as e:
        print(f'   ✘ 获取景区数据失败: {e}')
        raise RuntimeError(f'阶段二（景区数据抓取）出错: {e}') from e

    if not pois:
        raise RuntimeError(
            '阶段二（景区数据抓取）出错：未获取到任何 POI 数据，'
            '请检查景区名称或网络连接。'
        )

    # ============================================================
    # 阶段 3：路线优化
    # ============================================================
    print('\n🗺️ 阶段三：路线优化...')
    try:
        route_result = route_optimizer.optimize_route(pois, intent, config)
        selected = route_result.get('selected_pois') or route_result.get('pois', [])
        selected_count = len(selected)
        walk_min = route_result.get('total_walking_minutes') or route_result.get('walking_time', 0)
        print('   ✔ 路线优化完成')
        print(f'     选中景点: {selected_count} 个 | 步行时间: {_format_duration(walk_min)}')
    except Exception as e:
        print(f'   ✘ 路线优化失败: {e}')
        raise RuntimeError(f'阶段三（路线优化）出错: {e}') from e

    # ============================================================
    # 阶段 4：生成地图
    # ============================================================
    print('\n🎨 阶段四：生成地图...')
    try:
        map_visualizer.generate_map(route_result, output_path, config)
        print('   ✔ 地图生成完成')
    except Exception as e:
        print(f'   ✘ 地图生成失败: {e}')
        raise RuntimeError(f'阶段四（地图可视化）出错: {e}') from e

    # ============================================================
    # 汇总 & 输出
    # ============================================================
    selected_pois = route_result.get('selected_pois') or route_result.get('pois', [])
    total_duration = (
        route_result.get('total_duration_minutes')
        or route_result.get('total_minutes')
        or (intent.get('duration_hours', 0) * 60)
    )
    walking_time = (
        route_result.get('total_walking_minutes')
        or route_result.get('walking_time')
        or 0
    )

    abs_output = str(Path(output_path).resolve())

    summary = {
        'scenic_name':    scenic_name,
        'city':           city,
        'poi_count':      len(selected_pois),
        'total_duration': _format_duration(total_duration),
        'walking_time':   _format_duration(walking_time),
        'output_file':    abs_output,
        'intent':         intent,
        'route_result':   route_result,
    }

    print(f'\n✅ 规划完成！地图已保存至: {summary["output_file"]}')
    print('───────────────────────────────────')
    print(f'  景区名称: {summary["scenic_name"]}')
    print(f'  景点数量: {summary["poi_count"]}')
    print(f'  游览时长: {summary["total_duration"]}')
    print(f'  步行时间: {summary["walking_time"]}')
    print(f'  输出文件: {summary["output_file"]}')
    print('───────────────────────────────────\n')

    # 如果用户指定了 --open，尝试在浏览器中打开
    if options.get('open'):
        try:
            webbrowser.open(f'file://{abs_output}')
        except Exception as e:
            print(f'⚠️  无法自动打开浏览器: {e}')

    return summary


# ---------- CLI 入口 ----------

def main():
    """命令行入口解析与执行。"""
    parser = argparse.ArgumentParser(
        description='次元旅人 - 智能旅游规划管线',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python pipeline.py --input "我想悠闲地逛西湖2小时，主要想看古建筑和自然风光"
  python pipeline.py --input "逛西湖2小时" --city 杭州 --output my-tour.html --open

参数说明:
  --input   用户自然语言输入（必填）
  --city    城市名称（可选，可从意图中推断）
  --output  输出 HTML 文件路径（默认: tour-map.html）
  --open    完成后自动在浏览器中打开
        """,
    )
    parser.add_argument('--input', '-i', type=str, required=True,
                        help='用户自然语言旅游需求描述')
    parser.add_argument('--city', '-c', type=str, default=None,
                        help='城市名称（可选，可从意图中推断）')
    parser.add_argument('--output', '-o', type=str, default='tour-map.html',
                        help='输出 HTML 文件路径（默认: tour-map.html）')
    parser.add_argument('--open', action='store_true', default=False,
                        help='完成后自动在浏览器中打开')

    args = parser.parse_args()

    options = {
        'city':   args.city,
        'output': args.output,
        'open':   args.open,
    }

    try:
        run_pipeline(args.input, options)
    except Exception as e:
        print(f'\n❌ 管线执行失败: {e}')
        if os.environ.get('DEBUG'):
            traceback.print_exc()
        sys.exit(1)


# 当作为脚本直接运行时执行 CLI
if __name__ == '__main__':
    main()
