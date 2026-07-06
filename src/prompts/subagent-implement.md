---
description: 完整实现工作流 - scout 收集上下文，planner 创建计划，worker 实现
---
使用 subagent 工具的 chain 参数执行此工作流：

1. 首先，使用 "scout" agent 查找所有与以下相关的代码：$@
2. 然后，使用 "planner" agent 为 "$@" 创建实现计划，使用上一步的上下文（使用 {previous} 占位符）
3. 最后，使用 "worker" agent 实现上一步的计划（使用 {previous} 占位符）

以链式执行，通过 {previous} 在步骤之间传递输出。