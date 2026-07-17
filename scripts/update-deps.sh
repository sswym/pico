#!/usr/bin/env bash
set -euo pipefail

echo "=== 升级所有依赖到最新版本 ==="
echo ""

# 记录升级前的 package.json
cp package.json /tmp/package-before.json

# 1. 升级依赖
echo "▸ bun update --latest ..."
bun update --latest 2>&1

echo ""
echo "▸ 变更的依赖："
diff --unified=0 /tmp/package-before.json package.json | grep '^[+-]' | grep -v '^[+-]{' | grep -v '^[+-]}' | grep -v '^[+-]$' || echo "  (无变化)"

rm -f /tmp/package-before.json

echo ""
echo "=== 运行测试验证 ==="
echo ""

# 2. 跑类型检查 + 测试
if bun run verify 2>&1; then
    echo ""
    echo "✅ 升级完成，验证通过"
else
    echo ""
    echo "❌ 验证失败！请检查上面的错误输出"
    exit 1
fi
