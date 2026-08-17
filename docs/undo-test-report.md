# 代码回退功能测试报告

日期:2026-08-16
被测功能:`src/extensions/undo/`(旁路观测式 undo/redo,命令 `/undo` `/redo` `/undo-status` `/undo-clear`)
设计文档:`docs/undo-design.md`

---

## 1. 自动化单元测试

**运行方式**:`bun test tests/undo.test.ts`
**结果**:32 pass / 0 fail(98 expect 调用)

### 1.1 纯状态层(7 条)

| 用例 | 验证点 | 结果 |
|---|---|---|
| capture → confirm 入栈并清空 redo | 条目 before/after 字段、pending 清理 | ✅ |
| 内容未变的 confirm 丢弃条目 | no-op edit 不产生 undo 条目 | ✅ |
| 失败工具调用取消 pending | isError 后无条目、重复 cancel 返回 false | ✅ |
| 无 pending 的 confirm 无操作 | 幽灵 toolCallId 安全 | ✅ |
| undo 后新捕获清空 redo 分支 | git/编辑器语义:新编辑使 redo 失效 | ✅ |
| trimUndoStack 保留最新 N 条 | maxEntries 超限淘汰最旧 | ✅ |
| describeState / emptyUndoResult | 状态汇总与失败结果构造 | ✅ |

### 1.2 端到端文件恢复(13 条,真实文件系统)

| 用例 | 验证点 | 结果 |
|---|---|---|
| write 新文件 → undo 删除 | 文件新增场景(created → deleted) | ✅ |
| edit → undo 恢复原内容 → redo 重放 | 单次回退 + 重做 | ✅ |
| 连续多次 undo 回到初始状态 | 多级撤销 + 空栈提示 | ✅ |
| undo 到创建前 → redo 重建文件 | 新增文件穿越 undo/redo 全链 | ✅ |
| 外部删除文件 → undo 重建 | 文件缺失时恢复 | ✅ |
| 目录被删 → undo 删除不重建目录 | 新增文件的目录边界 | ✅ |
| blob 丢失 → 优雅失败不损坏文件 | 缓存被清后 undo 报错、条目回滚回栈、文件保持 | ✅ |
| 空 redo 栈失败 | 非法回退边界 | ✅ |
| 多文件独立跟踪 | 文件 A 的 undo 不影响文件 B | ✅ |
| undo 导航到捕获叶 / redo 导航到确认叶 | 对话随文件一起回退/前进(leafId 导航) | ✅ |
| redo 使用 afterLeafId 前进 | 编辑完成后对话位置正确恢复 | ✅ |
| 无导航能力(headless)降级纯文件回退 | 消息提示 "(conversation not rewound: non-interactive)" | ✅ |
| 导航失败不阻断文件恢复 | 文件已恢复,消息不含 rewound | ✅ |

### 1.3 扩展工厂接线(8 条,fakePi 驱动)

| 用例 | 验证点 | 结果 |
|---|---|---|
| 注册 4 个命令 | /undo /redo /undo-status /undo-clear | ✅ |
| tool_call→tool_result 全链捕获 + /undo 恢复 | 事件 → blob → 栈 → 命令闭环 | ✅ |
| 失败 tool_result 不入栈 | isError=true 后 /undo 报 No undo history | ✅ |
| settings 禁用跳过捕获并阻断命令 | undo.enabled=false | ✅ |
| /undo-clear 清栈与缓存目录 | 缓存目录物理删除 | ✅ |
| session_shutdown 丢弃内存态 | 新会话无历史 | ✅ |
| 工厂命令级 redo | /undo 后 /redo 恢复 | ✅ |

## 2. 真实操作场景测试(TUI 实机)

**方式**:tmux 启动 pico 真实 TUI(源码模式,真实模型 deepseek-v4-flash),隔离项目目录 + 真实 PICO_HOME。

### 2.1 场景流程与结果

| 步骤 | 操作 | 观察结果 | 结论 |
|---|---|---|---|
| 1 | 要求 AI:write 创建 greeting.txt(hello world)→ edit 改 hello pico | 两个工具依次执行,`-1 hello world / +1 hello pico` diff 正常 | ✅ 捕获链路生效 |
| 2 | 检查 undo 缓存 | `cache/undo/<sessionId>/blobs/` 两个 blob(hello world、hello pico 各自 sha256) | ✅ 内容寻址落盘 |
| 3 | `/undo` ×1 | 文件内容变回 "hello world"(撤销 edit) | ✅ 单次回退 |
| 4 | `/undo` ×2 | 文件被删除(撤销 write,回到创建前) | ✅ 新增文件回退 |
| 5 | `/redo` ×1 | 文件重建为 "hello world" | ✅ 重建 |
| 6 | `/redo` ×2 | 文件变回 "hello pico" | ✅ 多级重做 |
| 7 | `/undo-status` | `Undo entries: 2/50, Redo entries: 0` | ✅ 状态可见 |
| 8 | `/undo-clear` + `/undo` | 缓存目录清空、报 "No undo history" | ✅ 非法回退边界 |
| 9 | 要求 AI:`ls node_modules` | AI 直接列出 fake-pkg(真实文件系统可见) | ✅ 无沙箱重定向 |

### 2.2 会话回退实机验证(第二轮 TUI)

| 步骤 | 操作 | 观察结果 | 结论 |
|---|---|---|---|
| 1 | 要求 AI:edit a.txt 内容 v1→v2 | Edit 卡 `-1 v1 +1 v2`,文件变 v2 | ✅ 捕获链路生效 |
| 2 | `/undo` | 文件回 v1,提示 "Undid edit on a.txt (created). **Conversation rewound.**",屏幕对话回退到操作前(Write 卡消失、输入框回到用户消息) | ✅ 文件 + 对话同步回退 |
| 3 | `/redo` | 文件回 v2,提示 "Redid edit on a.txt (created). **Conversation restored.**" | ✅ 文件 + 对话同步前进 |
| 4 | write 新文件 → `/undo` | 文件删除,对话回退到「含该 Write 的 assistant 消息的父」——Write 卡不再残留(初版残留,修复为 findUndoTargetParent 向上查找后消失) | ✅ 操作卡彻底消失 |

### 2.2 文件损坏验证

- undo/redo 全程文件内容与预期一致,无截断/乱码/权限异常;
- blob 缺失路径(clear 后 undo)不损坏文件,条目回滚回栈;
- 目录被删后的 undo 删除语义正确(不重建不存在文件的目录)。

## 3. 全量回归

```
bun run verify → 1337 pass / 0 fail / 4259 expect calls(55 files)
```

(原 1305 + undo 新增 32,全部通过,含 tsc --noEmit 类型检查)

## 4. 已知局限(设计内)

- 只追踪 edit/write 工具;bash 直写/git 操作不在回滚范围(与 Claude Code 一致);
- 会话内 undo/redo;跨会话恢复未实现(blob 保留,预留接口);
- 无 diff 预览 UI(v1 命令栈);无工具失败自动回滚(与 OpenCode/Claude 一致);
- 会话回退依赖交互模式(非交互自动降级纯文件回退);navigateTree 导航失败不阻断文件恢复。
- undo 恢复文件时不检测外部并发修改(快照优先,幂等)。

## 5. 结论

自动化测试(32 条)+ 真实操作场景(9 步文件回退 + 4 步会话回退)全部通过;`bun run verify` 全绿;AI 工具直连真实文件系统(核心设计目标)。满足提交门槛。
