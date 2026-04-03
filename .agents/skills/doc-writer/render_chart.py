#!/usr/bin/env python3
"""
render_chart.py — Render charts and dashboards from JSON data to image files.

Requires: matplotlib (pip install matplotlib)

Usage:
    python render_chart.py --input data.json --output docs/images/chart.png
    python render_chart.py --input data.json --type pie --output docs/images/pie.png
    python render_chart.py --input data.json --type dashboard --output docs/images/dashboard.png

Input JSON format by chart type:
  bar / line / area:
    {
      "title": "Monthly Revenue",
      "xlabel": "Month",
      "ylabel": "Revenue ($)",
      "series": [
        {"label": "2024", "x": ["Jan","Feb","Mar"], "y": [100, 200, 150]},
        {"label": "2025", "x": ["Jan","Feb","Mar"], "y": [120, 220, 180]}
      ]
    }

  pie / donut:
    {
      "title": "Market Share",
      "labels": ["Product A", "Product B", "Product C"],
      "values": [45, 30, 25]
    }

  horizontal_bar:
    {
      "title": "Top Features",
      "labels": ["Feature A", "Feature B"],
      "values": [80, 65]
    }

  dashboard:
    {
      "title": "Project Dashboard",
      "charts": [
        { "type": "bar", "title": "Weekly Calls", ... },
        { "type": "pie", "title": "Status", ... }
      ]
    }
"""

import argparse
import json
import sys
from pathlib import Path


def _apply_style(ax, title: str, xlabel: str = "", ylabel: str = "") -> None:
    ax.set_title(title, fontsize=13, fontweight="bold", pad=10)
    if xlabel:
        ax.set_xlabel(xlabel, fontsize=10)
    if ylabel:
        ax.set_ylabel(ylabel, fontsize=10)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)


def render_bar(ax, data: dict, stacked: bool = False) -> None:
    import matplotlib.pyplot as plt

    series = data.get("series", [])
    if not series:
        raise ValueError("'series' is required for bar chart")

    colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]
    width = 0.8 / max(len(series), 1)
    xs = range(len(series[0]["x"]))

    for i, s in enumerate(series):
        offsets = [x + i * width for x in xs]
        ax.bar(offsets, s["y"], width=width, label=s.get("label", f"Series {i+1}"), color=colors[i % len(colors)], alpha=0.85)

    ax.set_xticks([x + width * (len(series) - 1) / 2 for x in xs])
    ax.set_xticklabels(series[0]["x"], rotation=30, ha="right")
    if len(series) > 1:
        ax.legend(fontsize=9)
    _apply_style(ax, data.get("title", ""), data.get("xlabel", ""), data.get("ylabel", ""))


def render_line(ax, data: dict, fill: bool = False) -> None:
    import matplotlib.pyplot as plt

    series = data.get("series", [])
    if not series:
        raise ValueError("'series' is required for line chart")

    colors = plt.rcParams["axes.prop_cycle"].by_key()["color"]
    for i, s in enumerate(series):
        color = colors[i % len(colors)]
        ax.plot(s["x"], s["y"], marker="o", linewidth=2, markersize=4, label=s.get("label", f"Series {i+1}"), color=color)
        if fill:
            ax.fill_between(s["x"], s["y"], alpha=0.15, color=color)

    ax.set_xticklabels(series[0]["x"], rotation=30, ha="right") if series else None
    if len(series) > 1:
        ax.legend(fontsize=9)
    _apply_style(ax, data.get("title", ""), data.get("xlabel", ""), data.get("ylabel", ""))


def render_pie(ax, data: dict, donut: bool = False) -> None:
    labels = data.get("labels", [])
    values = data.get("values", [])
    if not labels or not values:
        raise ValueError("'labels' and 'values' are required for pie chart")

    wedge_props = {"width": 0.5} if donut else {}
    ax.pie(
        values,
        labels=labels,
        autopct="%1.1f%%",
        startangle=140,
        wedgeprops=wedge_props,
        textprops={"fontsize": 9},
    )
    ax.set_title(data.get("title", ""), fontsize=13, fontweight="bold", pad=10)


def render_horizontal_bar(ax, data: dict) -> None:
    labels = data.get("labels", [])
    values = data.get("values", [])
    if not labels or not values:
        raise ValueError("'labels' and 'values' required for horizontal_bar")

    bars = ax.barh(labels, values, alpha=0.85)
    for bar, val in zip(bars, values):
        ax.text(bar.get_width() + max(values) * 0.01, bar.get_y() + bar.get_height() / 2, str(val), va="center", fontsize=9)
    ax.invert_yaxis()
    _apply_style(ax, data.get("title", ""), data.get("xlabel", ""), "")


RENDERERS = {
    "bar": render_bar,
    "line": render_line,
    "area": lambda ax, data: render_line(ax, data, fill=True),
    "pie": render_pie,
    "donut": lambda ax, data: render_pie(ax, data, donut=True),
    "horizontal_bar": render_horizontal_bar,
}


def render_single(data: dict, chart_type: str, output_path: Path, dpi: int = 150) -> None:
    import matplotlib.pyplot as plt

    if chart_type not in RENDERERS:
        raise ValueError(f"Unknown chart type '{chart_type}'. Choose from: {', '.join(RENDERERS)}")

    fig, ax = plt.subplots(figsize=(10, 6))
    RENDERERS[chart_type](ax, data)
    fig.tight_layout()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=dpi, bbox_inches="tight")
    plt.close(fig)
    print(f"Saved: {output_path}")


def render_dashboard(data: dict, output_path: Path, dpi: int = 150) -> None:
    import math

    import matplotlib.pyplot as plt

    charts = data.get("charts", [])
    if not charts:
        raise ValueError("'charts' list is required for dashboard type")

    n = len(charts)
    cols = min(n, 3)
    rows = math.ceil(n / cols)
    fig, axes = plt.subplots(rows, cols, figsize=(cols * 7, rows * 5))

    # Flatten axes into a list regardless of shape
    if n == 1:
        axes_flat = [axes]
    elif rows == 1:
        axes_flat = list(axes)
    else:
        axes_flat = [ax for row in axes for ax in row]

    for i, chart_def in enumerate(charts):
        ctype = chart_def.get("type", "bar")
        if ctype not in RENDERERS:
            axes_flat[i].set_visible(False)
            continue
        RENDERERS[ctype](axes_flat[i], chart_def)

    # Hide unused axes
    for j in range(n, len(axes_flat)):
        axes_flat[j].set_visible(False)

    if data.get("title"):
        fig.suptitle(data["title"], fontsize=16, fontweight="bold", y=1.01)

    fig.tight_layout()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=dpi, bbox_inches="tight")
    plt.close(fig)
    print(f"Saved dashboard: {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Render charts and dashboards from JSON data")
    parser.add_argument("--input", "-i", type=Path, required=True, help="JSON data file")
    parser.add_argument(
        "--type",
        "-t",
        choices=[*RENDERERS.keys(), "dashboard"],
        default="bar",
        help="Chart type (default: bar)",
    )
    parser.add_argument("--output", "-o", type=Path, required=True, help="Output image path (.png/.svg/.pdf)")
    parser.add_argument("--dpi", type=int, default=150, help="Image DPI (default: 150)")
    args = parser.parse_args()

    if not args.input.exists():
        print(f"Error: input file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    data = json.loads(args.input.read_text(encoding="utf-8"))

    if args.type == "dashboard":
        render_dashboard(data, args.output, dpi=args.dpi)
    else:
        render_single(data, args.type, args.output, dpi=args.dpi)


if __name__ == "__main__":
    main()
