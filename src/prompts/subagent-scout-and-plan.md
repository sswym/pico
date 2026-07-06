---
description: Scout 收集上下文，planner 创建实现计划（不实现）
---
使用 subagent 工具的 chain 参数执行此工作流：

1. 首先，使用 "scout" agent 查找所有与以下相关的代码：$@
2. 然后，使用 "planner" agent 为 "$@" 创建实现计划，使用上一步的上下文（使用 {previous} 占位符）

以链式执行，通过 {previous} 在步骤之间传递输出。不要实现——只返回计划。