# 社実09

Perlで作った古いHTTP/1.0風の小さいサーバー群。

```sh
docker compose up --build
```

```sh
curl "http://localhost:8081/?name=alice"
```

`server1` から `server7` まで順番に機能を足している。

```sh
bun scripts/loadtest.ts
```

結果は `results/run-*/summary.csv`, `summary_median.csv`, `metrics.csv` に出る。

```sh
uv run scripts/plot_results.py
```

グラフは最新の `results/run-*/graphs/` にPNGで出る。
各serverごとの画像は `results/run-*/graphs/by_server/` に出る。
実行時に `graphs/` は一度空にして作り直す。
