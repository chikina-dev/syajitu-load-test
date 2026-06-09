#!/usr/bin/env python3
# /// script
# dependencies = ["matplotlib"]
# ///

import csv
import shutil
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.ticker import PercentFormatter


SERVERS = ["server1", "server2", "server3", "server4", "server5", "server6", "server7"]
SCENARIOS = ["short-random", "short-same", "huge-random", "huge-same", "slow-header"]

SCENARIO_LABELS = {
    "short-random": "短いランダム",
    "short-same": "短い同一",
    "huge-random": "巨大ランダム",
    "huge-same": "巨大同一",
    "slow-header": "低速ヘッダ",
}

SERVER_LABELS = {
    "server1": "server1\n単純",
    "server2": "server2\n制限",
    "server3": "server3\nメモリ",
    "server4": "server4\n待ち列",
    "server5": "server5\nprefork",
    "server6": "server6\n分類",
    "server7": "server7\n全部入り",
}

SERVER_NOTES = {
    "server1": "基準。単一プロセスでHTTP/1.0を返すだけなので、攻撃と通常probeが同じ列に並ぶ。",
    "server2": "Rate Limit単体の対照。攻撃の一部は止まるが、単一プロセスなので通常probeの保護は弱い。",
    "server3": "メモリ増強とcacheの対照。巨大ランダムでcacheが膨らみ、OOMしやすい。",
    "server4": "待ち列の対照。接続は粘れるが、処理能力は単一なので詰まりやすい。",
    "server5": "preforkの対照。処理能力は上がるが、攻撃も処理してしまうため通常probeが巻き込まれる回がある。",
    "server6": "分類だけの対照。分類しても処理能力や制限がないので、負荷耐性は上がりにくい。",
    "server7": "全部入り。攻撃を早めに捨て、preforkで通常probeを守るDoS耐性サーバー。",
}

COLORS = {
    "server1": "#7f8c8d",
    "server2": "#c0392b",
    "server3": "#8e44ad",
    "server4": "#d68910",
    "server5": "#2471a3",
    "server6": "#229954",
    "server7": "#111111",
}


def main():
    run_dir = latest_run()
    report_dir = run_dir / "graphs"
    by_server_dir = report_dir / "by_server"
    if report_dir.exists():
        shutil.rmtree(report_dir)
    report_dir.mkdir(parents=True, exist_ok=True)
    by_server_dir.mkdir(exist_ok=True)

    median_rows = read_csv(run_dir / "summary_median.csv")
    summary_rows = read_csv(run_dir / "summary.csv")

    configure_japanese_font()
    plt.rcParams.update({
        "figure.dpi": 160,
        "savefig.dpi": 160,
        "font.size": 9,
        "axes.titlesize": 11,
        "axes.labelsize": 9,
        "legend.fontsize": 8,
        "xtick.labelsize": 8,
        "ytick.labelsize": 8,
        "axes.unicode_minus": False,
    })

    plot_success_heatmap(median_rows, report_dir / "01_全体_成功率ヒートマップ.png")
    plot_server7_comparison(median_rows, report_dir / "02_全体_server7比較.png")
    plot_dos_defense_map(median_rows, report_dir / "03_全体_DoS耐性マップ.png")
    plot_resource_effect(median_rows, report_dir / "04_全体_リソースと効果.png")
    plot_run_variance(summary_rows, report_dir / "05_全体_結果のブレ.png")

    for server in SERVERS:
        plot_server_profile(median_rows, server, by_server_dir / f"{server}_説明用.png")

    print(f"run={run_dir}")
    print(f"report_graphs={report_dir}")
    print(f"server_graphs={by_server_dir}")


def configure_japanese_font():
    candidates = [
        "/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc",
        "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc",
        "/Library/Fonts/NotoSansCJK-Regular.ttc",
        "/Library/Fonts/NotoSansJP-Regular.otf",
    ]
    for path in candidates:
        font_path = Path(path)
        if font_path.exists():
            font_manager.fontManager.addfont(str(font_path))
            plt.rcParams["font.family"] = font_manager.FontProperties(fname=str(font_path)).get_name()
            return


def latest_run():
    runs = sorted(Path("results").glob("run-*/summary_median.csv"))
    if not runs:
        raise SystemExit("summary_median.csv not found")
    return runs[-1].parent


def read_csv(path):
    with path.open(newline="") as f:
        return list(csv.DictReader(f))


def rows_for(rows, scenario=None, server=None):
    out = rows
    if scenario:
        out = [r for r in out if r["scenario"] == scenario]
    if server:
        out = [r for r in out if r["server"] == server]
    return out


def by_key(rows, scenario, server):
    found = rows_for(rows, scenario, server)
    return found[0] if found else {}


def num(row, key):
    value = row.get(key, "")
    if value in ("", "true", "false"):
        return 0.0
    return float(value)


def avg(values):
    return sum(values) / len(values) if values else 0


def med(values):
    ordered = sorted(values)
    if not ordered:
        return 0
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def success(row):
    return num(row, "probeSuccessRate") * 100


def attack_ok_rate(row):
    total = max(1, num(row, "attackTotal"))
    return num(row, "attackOk") / total * 100


def attack_block_rate(row):
    total = max(1, num(row, "attackTotal"))
    return (num(row, "attack503") + num(row, "attackFailed")) / total * 100


def style_axis(ax):
    ax.grid(axis="y", color="#dddddd", linewidth=0.8)
    ax.spines[["top", "right"]].set_visible(False)


def plot_success_heatmap(rows, path):
    values = [[success(by_key(rows, scenario, server)) for scenario in SCENARIOS] for server in SERVERS]

    fig, ax = plt.subplots(figsize=(9, 5.2))
    image = ax.imshow(values, cmap="YlGn", vmin=0, vmax=100)

    ax.set_title("通常probe成功率: どの攻撃で通常利用を守れたか", loc="left", weight="bold")
    ax.text(0, -1.15, "濃い緑ほど成功率が高い。server7は巨大リクエストと低速ヘッダで特に強い。", fontsize=9)
    ax.set_xticks(range(len(SCENARIOS)))
    ax.set_xticklabels([SCENARIO_LABELS[s] for s in SCENARIOS], rotation=25, ha="right")
    ax.set_yticks(range(len(SERVERS)))
    ax.set_yticklabels([SERVER_LABELS[s].replace("\n", " ") for s in SERVERS])

    for y, server in enumerate(SERVERS):
        for x, scenario in enumerate(SCENARIOS):
            value = values[y][x]
            color = "white" if value > 70 else "#111111"
            ax.text(x, y, f"{value:.0f}%", ha="center", va="center", color=color, weight="bold")

    cbar = fig.colorbar(image, ax=ax, fraction=0.046, pad=0.04)
    cbar.set_label("probe成功率")
    cbar.ax.yaxis.set_major_formatter(PercentFormatter(100))
    fig.tight_layout()
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


def plot_server7_comparison(rows, path):
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5))

    ax = axes[0]
    width = 0.23
    focus = ["server1", "server5", "server7"]
    for i, server in enumerate(focus):
        vals = [success(by_key(rows, scenario, server)) for scenario in SCENARIOS]
        ax.bar([x + (i - 1) * width for x in range(len(SCENARIOS))], vals, width, label=SERVER_LABELS[server].replace("\n", " "), color=COLORS[server])
    ax.set_title("基準・prefork・全部入りの比較", loc="left", weight="bold")
    ax.set_ylabel("probe成功率")
    ax.set_xticks(range(len(SCENARIOS)))
    ax.set_xticklabels([SCENARIO_LABELS[s] for s in SCENARIOS], rotation=25, ha="right")
    ax.yaxis.set_major_formatter(PercentFormatter(100))
    ax.set_ylim(0, 105)
    ax.legend(frameon=False)
    style_axis(ax)

    ax = axes[1]
    deltas1 = []
    deltas5 = []
    for scenario in SCENARIOS:
        s7 = success(by_key(rows, scenario, "server7"))
        deltas1.append(s7 - success(by_key(rows, scenario, "server1")))
        deltas5.append(s7 - success(by_key(rows, scenario, "server5")))
    ax.bar([x - 0.13 for x in range(len(SCENARIOS))], deltas1, 0.26, label="server1との差", color="#566573")
    ax.bar([x + 0.13 for x in range(len(SCENARIOS))], deltas5, 0.26, label="server5との差", color="#1f618d")
    ax.axhline(0, color="#111111", linewidth=0.8)
    ax.set_title("server7でどれだけ改善したか", loc="left", weight="bold")
    ax.set_ylabel("成功率の差分")
    ax.set_xticks(range(len(SCENARIOS)))
    ax.set_xticklabels([SCENARIO_LABELS[s] for s in SCENARIOS], rotation=25, ha="right")
    ax.yaxis.set_major_formatter(PercentFormatter(100))
    ax.legend(frameon=False)
    style_axis(ax)

    fig.suptitle("server7は何を改善したか", x=0.02, ha="left", weight="bold", fontsize=14)
    fig.tight_layout(rect=[0, 0, 1, 0.92])
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


def plot_dos_defense_map(rows, path):
    fig, axes = plt.subplots(1, len(SCENARIOS), figsize=(15, 4), sharex=True, sharey=True)

    for ax, scenario in zip(axes, SCENARIOS):
        for server in SERVERS:
            row = by_key(rows, scenario, server)
            x = attack_ok_rate(row)
            y = success(row)
            ax.scatter(x, y, color=COLORS[server], s=60)
            ax.text(x + 1.5, y + 1.5, server.replace("server", "s"), fontsize=7)
        ax.set_title(SCENARIO_LABELS[scenario], weight="bold")
        ax.axvspan(0, 20, color="#eafaf1", zorder=0)
        ax.axhspan(80, 100, color="#eafaf1", zorder=0)
        ax.grid(color="#dddddd", linewidth=0.8)
        ax.spines[["top", "right"]].set_visible(False)

    axes[0].set_ylabel("通常probe成功率")
    for ax in axes:
        ax.set_xlabel("攻撃を200で通した割合")
        ax.xaxis.set_major_formatter(PercentFormatter(100))
        ax.yaxis.set_major_formatter(PercentFormatter(100))
        ax.set_xlim(-2, 105)
        ax.set_ylim(-2, 105)

    fig.suptitle("DoS耐性マップ: 左上ほど攻撃を捨てつつ通常probeを守れている", x=0.02, ha="left", weight="bold")
    fig.tight_layout(rect=[0, 0, 1, 0.9])
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


def plot_resource_effect(rows, path):
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5))

    avg_success = {
        server: avg([success(r) for r in rows_for(rows, server=server)])
        for server in SERVERS
    }
    max_mem = {
        server: max(num(r, "memMaxMiB") for r in rows_for(rows, server=server))
        for server in SERVERS
    }
    max_pids = {
        server: max(num(r, "pidsMax") for r in rows_for(rows, server=server))
        for server in SERVERS
    }

    ax = axes[0]
    for server in SERVERS:
        ax.scatter(max_mem[server], avg_success[server], s=35 + max_pids[server] * 18, color=COLORS[server], alpha=0.85)
        ax.text(max_mem[server] + 1, avg_success[server], server, fontsize=8)
    ax.set_title("メモリ使用量と平均probe成功率", loc="left", weight="bold")
    ax.set_xlabel("最大メモリ使用量(MiB)")
    ax.set_ylabel("5シナリオ平均probe成功率")
    ax.yaxis.set_major_formatter(PercentFormatter(100))
    style_axis(ax)

    ax = axes[1]
    vals = [max_pids[s] for s in SERVERS]
    ax.bar(SERVERS, vals, color=[COLORS[s] for s in SERVERS])
    ax.set_title("複数プロセスを使えているか", loc="left", weight="bold")
    ax.set_ylabel("最大プロセス数")
    ax.set_xticks(range(len(SERVERS)))
    ax.set_xticklabels([SERVER_LABELS[s] for s in SERVERS], rotation=45, ha="right")
    style_axis(ax)

    fig.suptitle("リソース追加が効果につながっているか", x=0.02, ha="left", weight="bold", fontsize=14)
    fig.tight_layout(rect=[0, 0, 1, 0.92])
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


def plot_run_variance(rows, path):
    fig, axes = plt.subplots(1, len(SCENARIOS), figsize=(15, 4), sharey=True)

    for ax, scenario in zip(axes, SCENARIOS):
        for i, server in enumerate(SERVERS):
            values = [success(r) for r in rows_for(rows, scenario, server)]
            ax.scatter([i] * len(values), values, color=COLORS[server], s=28)
            ax.plot([i - 0.2, i + 0.2], [med(values), med(values)], color="#111111", linewidth=1)
        ax.set_title(SCENARIO_LABELS[scenario], weight="bold")
        ax.set_xticks(range(len(SERVERS)))
        ax.set_xticklabels([SERVER_LABELS[s] for s in SERVERS], rotation=70, ha="right")
        ax.yaxis.set_major_formatter(PercentFormatter(100))
        ax.set_ylim(0, 105)
        style_axis(ax)

    axes[0].set_ylabel("3回それぞれのprobe成功率")
    fig.suptitle("結果のブレ: 点が離れているほど同じ条件でも不安定", x=0.02, ha="left", weight="bold")
    fig.tight_layout(rect=[0, 0, 1, 0.9])
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


def plot_server_profile(rows, server, path):
    server_rows = rows_for(rows, server=server)
    best = max(server_rows, key=success)
    worst = min(server_rows, key=success)
    avg_success = avg([success(r) for r in server_rows])
    avg_attack_ok = avg([attack_ok_rate(r) for r in server_rows])
    max_mem = max(num(r, "memMaxMiB") for r in server_rows)
    max_cpu = max(num(r, "cpuMaxPercent") for r in server_rows)
    max_pids = max(num(r, "pidsMax") for r in server_rows)
    oom = any(r["oomKilled"] == "true" for r in server_rows)

    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    fig.suptitle(f"{server} 説明用サマリ", x=0.02, ha="left", weight="bold", fontsize=15)
    fig.text(0.02, 0.94, SERVER_NOTES[server], ha="left", fontsize=9)
    fig.text(
        0.02,
        0.89,
        f"平均probe成功率: {avg_success:.1f}% / 攻撃を200で通した平均: {avg_attack_ok:.1f}% / "
        f"最良: {SCENARIO_LABELS[best['scenario']]} {success(best):.0f}% / 最悪: {SCENARIO_LABELS[worst['scenario']]} {success(worst):.0f}%"
        + (" / OOMあり" if oom else ""),
        ha="left",
        fontsize=9,
    )

    ax = axes[0][0]
    vals = [success(by_key(rows, scenario, server)) for scenario in SCENARIOS]
    ax.bar(SCENARIOS, vals, color=COLORS[server])
    ax.axhline(avg_success, color="#111111", linewidth=1, linestyle="--", label=f"平均 {avg_success:.1f}%")
    ax.set_title("通常probeをどれだけ守れたか", loc="left", weight="bold")
    ax.set_ylabel("probe成功率")
    ax.set_xticks(range(len(SCENARIOS)))
    ax.set_xticklabels([SCENARIO_LABELS[s] for s in SCENARIOS], rotation=25, ha="right")
    ax.yaxis.set_major_formatter(PercentFormatter(100))
    ax.set_ylim(0, 105)
    ax.legend(frameon=False)
    style_axis(ax)

    ax = axes[0][1]
    vals = [attack_ok_rate(by_key(rows, scenario, server)) for scenario in SCENARIOS]
    ax.bar(SCENARIOS, vals, color="#2e86c1")
    ax.set_title("攻撃をどれだけ200で通してしまったか", loc="left", weight="bold")
    ax.set_ylabel("攻撃200率")
    ax.set_xticks(range(len(SCENARIOS)))
    ax.set_xticklabels([SCENARIO_LABELS[s] for s in SCENARIOS], rotation=25, ha="right")
    ax.yaxis.set_major_formatter(PercentFormatter(100))
    ax.set_ylim(0, 105)
    style_axis(ax)

    ax = axes[1][0]
    blocked = [attack_block_rate(by_key(rows, scenario, server)) for scenario in SCENARIOS]
    ax.bar(SCENARIOS, blocked, color="#922b21")
    ax.set_title("攻撃を失敗/切断/503にできた割合", loc="left", weight="bold")
    ax.set_ylabel("攻撃抑制率")
    ax.set_xticks(range(len(SCENARIOS)))
    ax.set_xticklabels([SCENARIO_LABELS[s] for s in SCENARIOS], rotation=25, ha="right")
    ax.yaxis.set_major_formatter(PercentFormatter(100))
    ax.set_ylim(0, 105)
    style_axis(ax)

    ax = axes[1][1]
    labels = ["CPU最大(%)", "メモリ最大(MiB)", "プロセス最大"]
    vals = [max_cpu, max_mem, max_pids]
    ax.bar(labels, vals, color=["#616a6b", "#7d3c98", "#117864"])
    ax.set_title("この結果を出すために使ったリソース", loc="left", weight="bold")
    ax.set_xticks(range(len(labels)))
    ax.set_xticklabels(labels, rotation=15, ha="right")
    style_axis(ax)

    fig.tight_layout(rect=[0, 0, 1, 0.85])
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


if __name__ == "__main__":
    main()
