"""只打包扩展资源，绝不将令牌、模型或 Python 虚拟环境放入 XPI。"""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parents[1]
source = root / "extension"
if not (source / "speech-worker.js").exists() or not (source / "vendor/ort-wasm-simd-threaded.wasm").exists():
    raise SystemExit("请先运行 npm ci 和 npm run build，生成内置识别资源。")
version = json.loads((source / "manifest.json").read_text(encoding="utf-8"))["version"]
target = root / "artifacts" / f"bilibili-assistant-{version}.xpi"
target.parent.mkdir(exist_ok=True)
with ZipFile(target, "w", ZIP_DEFLATED) as archive:
    for path in sorted(source.rglob("*")):
        if path.is_file():
            archive.write(path, path.relative_to(source))
print(f"已生成未签名插件：{target}")
