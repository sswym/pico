#!/usr/bin/env python3
"""检查 src/extensions/ 下每个扩展目录在 tests/ 中是否有对应测试。

用法:
    python3 scripts/check-ext-tests.py              # 检查本仓库
    python3 scripts/check-ext-tests.py --selftest   # 跑内嵌自检
"""
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def find_extensions(ext_dir: Path) -> list[str]:
    return sorted(p.name for p in ext_dir.iterdir() if p.is_dir())


def find_test_names(tests_dir: Path) -> list[str]:
    return sorted(p.stem for p in tests_dir.glob("*.test.ts"))


def missing_tests(ext_names: list[str], test_names: list[str]) -> list[str]:
    missing = []
    for name in ext_names:
        # 匹配 <name>.test.ts 或 <name>-*.test.ts（如 lsp-deep.test.ts）
        if any(t == name or t.startswith(name + "-") for t in test_names):
            continue
        missing.append(name)
    return missing


def check(ext_dir: Path, tests_dir: Path) -> int:
    exts = find_extensions(ext_dir)
    tests = find_test_names(tests_dir)
    missing = missing_tests(exts, tests)
    if not missing:
        print(f"OK: 全部 {len(exts)} 个扩展均有对应测试")
        return 0
    for name in missing:
        print(f"MISSING: 扩展 {name} 没有测试文件 (tests/{name}.test.ts)")
    print(f"{len(missing)}/{len(exts)} 个扩展缺少测试")
    return 1


def selftest() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        ext_dir = Path(tmp) / "ext"
        tests_dir = Path(tmp) / "tests"
        for name in ("a", "b", "c"):
            (ext_dir / name).mkdir(parents=True)
        for name in ("a.test.ts", "b-deep.test.ts", "ab.test.ts"):
            (tests_dir / name).touch()
        missing = missing_tests(find_extensions(ext_dir), find_test_names(tests_dir))
        # c 无测试；ab.test.ts 不得误判为 a 的测试；b-deep.test.ts 算 b 的测试
        assert missing == ["c"], f"selftest 失败: {missing}"
    print("selftest: 通过")
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    return check(REPO / "src" / "extensions", REPO / "tests")


if __name__ == "__main__":
    sys.exit(main())
