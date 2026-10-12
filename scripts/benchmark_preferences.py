"""固定训练前缀与保留集上的真实 MiniLM + Transformer/MLP 学习曲线。"""
import argparse
import csv
import json
import platform
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from preferences import PreferenceService, EMBEDDING_MODEL


def metrics(scores, items, threshold):
    positive = [item["liked"] for item in items]
    tp = sum(score >= 0.5 and liked for score, liked in zip(scores, positive))
    tn = sum(score < 0.5 and not liked for score, liked in zip(scores, positive))
    fp = sum(score >= 0.5 and not liked for score, liked in zip(scores, positive))
    fn = sum(score < 0.5 and liked for score, liked in zip(scores, positive))
    precision = tp / (tp + fp) if tp + fp else 0
    recall = tp / (tp + fn) if tp + fn else 0
    targets = [item["rating"] / 3 for item in items]
    return {"accuracy": (tp + tn) / len(items), "precision": precision, "recall": recall,
            "f1": 2 * precision * recall / (precision + recall) if precision + recall else 0,
            "mae": sum(abs(score - target) for score, target in zip(scores, targets)) / len(items),
            "false_hide_liked": sum(score < threshold and liked for score, liked in zip(scores, positive)),
            "hidden_disliked": sum(score < threshold and not liked for score, liked in zip(scores, positive))}


def run(output, cache, seeds, epochs):
    import torch
    from preference_model import fit_head, pack_features
    torch.set_num_threads(4)
    data = json.loads((ROOT / "tests/fixtures/preference_titles.json").read_text(encoding="utf-8"))
    train = [item for item in data if item["split"] == "train"]
    test = [item for item in data if item["split"] == "test"]
    assert len(train) == 120 and len(test) == 30
    output.mkdir(parents=True, exist_ok=True)
    service = PreferenceService(cache)
    service.activate_runtime(ttl=7200)
    try:
        print("编码 150 个标题（真实多语言 MiniLM，CPU）…", flush=True)
        started = time.perf_counter()
        features = service._features([item["title"] for item in train + test])
        encode_seconds = time.perf_counter() - started
        train_features, test_features = features[:120], features[120:]
        test_batch, test_mask = pack_features(test_features)
        results = []
        predictions = []
        for size in range(20, 121, 10):
            row = {"training_samples": size, "production_enabled": size > 30}
            if size <= 30:
                row["note"] = "离线诊断训练；产品仍不运行模型，全部保留"
            runs = []
            for seed in seeds:
                started = time.perf_counter()
                head = fit_head(train_features[:size], [item["rating"] for item in train[:size]], epochs=epochs, seed=seed)
                seconds = time.perf_counter() - started
                with torch.inference_mode():
                    scores = torch.sigmoid(head(test_batch, test_mask)).tolist()
                measured = metrics(scores, test, 0.35)
                runs.append({"seed": seed, "training_seconds": seconds, **measured})
                for item, score in zip(test, scores):
                    predictions.append({"training_samples": size, "seed": seed, **item, "score": score, "hidden": score < 0.35})
            for key in ["accuracy", "precision", "recall", "f1", "mae", "false_hide_liked", "hidden_disliked", "training_seconds"]:
                values = [entry[key] for entry in runs]
                row[key] = sum(values) / len(values)
                row[key + "_min"] = min(values)
                row[key + "_max"] = max(values)
            row["runs"] = runs
            results.append(row)
            print(f"n={size}: accuracy={row['accuracy']:.3f}, F1={row['f1']:.3f}, MAE={row['mae']:.3f}, 误隐藏喜欢={row['false_hide_liked']:.1f}/15", flush=True)
        report = {"embedding_model": EMBEDDING_MODEL, "device": "cpu", "torch_version": torch.__version__,
                  "python": platform.python_version(), "epochs": epochs, "seeds": seeds,
                  "train_count": 120, "test_count": 30, "encoding_seconds": encode_seconds,
                  "decision_threshold": 0.5, "hide_threshold": 0.35, "results": results,
                  "production_gate": "20/30条仅离线诊断，产品不加载模型、不隐藏测试视频",
                  "limitations": "人工合成标题、固定30条测试、同主题跨集合；仅用于实现验证，不代表真实推荐准确率。未使用测试标签训练或选择阈值。"}
        (output / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        (output / "predictions.json").write_text(json.dumps(predictions, ensure_ascii=False, indent=2), encoding="utf-8")
        columns = ["training_samples", "production_enabled", "accuracy", "f1", "mae", "false_hide_liked", "hidden_disliked", "training_seconds"]
        with (output / "learning_curve.csv").open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
            writer.writeheader(); writer.writerows(results)
        lines = ["# 模拟用户偏好测试报告", "", f"真实 `{EMBEDDING_MODEL}` token 嵌入 + CPU Transformer/MLP；120 条训练、固定 30 条测试（喜欢/不喜欢各 15）。", "",
                 f"训练规模 20–120，步长 10；每个可运行规模独立从头训练 {epochs} epochs，种子 {seeds}。二分类阈值 0.5，隐藏阈值固定 0.35。20/30 条也进行独立离线诊断训练，但产品仍遵守 >30 门槛，不运行模型、不隐藏视频。", "",
                 "|训练数|产品运行|离线准确率均值（范围）|F1|四级目标 MAE|假设运行时误隐藏喜欢 /15|假设运行时隐藏不喜欢 /15|训练秒数均值|", "|---|---|---|---|---|---|---|---|"]
        for row in results:
            enabled = "是" if row["production_enabled"] else "否（离线诊断）"
            lines.append(f"|{row['training_samples']}|{enabled}|{row['accuracy']:.1%} ({row['accuracy_min']:.1%}–{row['accuracy_max']:.1%})|{row['f1']:.3f}|{row['mae']:.3f}|{row['false_hide_liked']:.1f}|{row['hidden_disliked']:.1f}|{row['training_seconds']:.2f}|")
        lines.extend(["", f"150 个标题的首次编码含模型加载耗时：{encode_seconds:.2f}s（不等同于稳态单标题延迟）。", "", report["limitations"], "", "数据、每条测试预测、CSV 和 JSON 结果与本报告一同保留。测试使用独立目录，不会写入个人模型或标签。"])
        (output / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    finally:
        service.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "reports/preference-benchmark")
    parser.add_argument("--cache", type=Path, default=ROOT / "backend/models/benchmark-preference")
    parser.add_argument("--seeds", type=int, nargs="+", default=[42, 43, 44])
    parser.add_argument("--epochs", type=int, default=45)
    args = parser.parse_args()
    run(args.output, args.cache, args.seeds, args.epochs)
