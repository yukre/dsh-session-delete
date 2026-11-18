# 会话删除插件 (dsh-session-delete)

给 DeepSeek Harness 的侧栏会话右键菜单新增一项 **「删除会话…」**，永久删除该会话及其对话日志。

## 为什么需要它

DSH 内置的 **归档 (Archive)** 与真正的 **删除 (Delete)** 是两件不同的事。归档只往工作区注册表写一个隐藏标记，会话日志一字不动、可随时取消归档恢复。DSH 也没有提供删除单个会话的 API：

- `SessionPersistence` 只有 `create / open / flush / stat / list`，没有 delete
- `WorkspaceRegistry.delete(id)` 删的是**工作区**，且注释明确「保留目录与全部会话日志」

本插件补上这个缺口，并**与归档严格分开**：归档是隐藏，删除是清除。

| | 归档（内置） | 删除（本插件） |
|---|---|---|
| 效果 | 从侧栏隐藏 | 从磁盘移除 |
| 会话日志 | 完整保留 | 永久删除 |
| 可恢复 | 可以 | **不可撤销** |
| 释放磁盘 | 否 | 是 |

## 使用方法

1. 鼠标移到左侧会话列表中的目标会话上，点行尾 **「…」** 菜单
2. 选择 **「删除会话…」**
3. 确认框显示该会话标题，确认后立即删除

## 安全设计

删除是不可逆操作，因此每一道闸门都是硬性的：

- **必须在确认框中确认**：显示会话标题，并明确提示不可撤销、同时提示"只想隐藏请用归档"
- **运行中的会话禁止删除**（`SESSION_RUNNING`）：日志仍在被写入时删除会损坏数据。这里**不会**代你取消正在跑的任务——你明确要求过不打断工作，所以先停止再删是你的选择，不是插件的选择
- **常驻但空闲的 Agent 会被先退役**：聊天机器人这类集成会为一个空闲会话长期保留 Agent。删除前先 `cancel`（`disposed` 原因）、等 `whenIdle()` 排干、再请各 provider 释放，最后才删目录——否则那个 Agent 会继续往已删路径写入，会话也会在内存表里变成"幽灵行"
- **会话 ID 白名单校验**：只允许单段安全字符，拒绝 `..`、`/`、`\`、NUL、绝对路径
- **路径越界防护**：解析后必须仍在会话根目录内
- **目标必须是真会话目录**：候选目录必须含 `session.v4.jsonl.zstd` 或 `session.lock`。只按目录名匹配会把 `attachments`、`.git` 这类普通目录当成会话递归删掉
- **有歧义就拒绝**（`AMBIGUOUS_LOCATION`）：同一 id 出现在两个 bucket 时不再"删第一个"，而是列出全部候选让你自己确认
- **连接信任栅栏**（`UNTRUSTED_CONNECTION`）：`webServer.register` 不经过 DSH 的连接信任检查，所以路由自己做——Host 必须是回环地址（DNS 重绑定伪造不了 Host）、`Sec-Fetch-Site: cross-site` 拒绝、`Origin` 存在时必须与 Host 同源、`Origin: null` 拒绝。这是 `dsh-session-api` 在生产上跑过的同一套栅栏
- **JSON Content-Type**：与信任栅栏相互独立，跨站表单无法设置它

## 删除的是什么

```
~/.dsh/sessions/<工作区编码>/<会话ID>/
  session.v4.jsonl.zstd   对话日志
  session.lock            写入锁文件（无数据）
```

删除即移除该会话目录。会话列表由扫描该目录树得出，因此删除后无需重建索引。

Host 端同时发出两个通知：

- `api-session/removed`——DSH 自己的 UI 通知，让侧栏立即移除该行
- `session-delete/removed`（载荷 `{ sessionId, paths }`）——本插件自有事件。集成方如果把会话 id 缓存在自己的文件里（例如聊天机器人把用户映射到会话），DSH 没有别的信号能让它知道这个 id 已经消失，订阅这个事件即可清理

## 验证记录

以下每一项都有对应的自动化测试（`npm test`，共 23 项），并且**先在旧代码上确认会失败、修复后再确认通过**：

| 场景 | 结果 |
|---|---|
| 正常删除测试会话 | ✅ `200 {"ok":true,...}`，目录已移除 |
| 不存在的会话 | ✅ `409 NOT_FOUND` |
| 运行中会话 | ✅ `409 SESSION_RUNNING`，且**不**取消该会话 |
| 空闲常驻 Agent | ✅ 先 cancel → whenIdle → 释放，再删目录 |
| 路径穿越 `../../etc` | ✅ `409 BAD_SESSION_ID` |
| 重绑定 Host | ✅ `403 UNTRUSTED_CONNECTION` |
| 伪造 Origin + Host 同行 | ✅ `403 UNTRUSTED_CONNECTION`（Host 栅栏拦下） |
| 跨站 Origin | ✅ `403 UNTRUSTED_CONNECTION` |
| `Sec-Fetch-Site: cross-site` | ✅ `403 UNTRUSTED_CONNECTION` |
| `Origin: null` | ✅ `403 UNTRUSTED_CONNECTION` |
| 应用页面自身请求 | ✅ `200` |
| 名字合法但非会话的目录（`attachments`、`.git`） | ✅ 不匹配，不删除 |
| 同一 id 出现在两个 bucket | ✅ `409 AMBIGUOUS_LOCATION`，列出双方，都不删 |
| 非 JSON Content-Type | ✅ `415 BAD_CONTENT_TYPE` |
| GET 方法 | ✅ `405 METHOD_NOT_ALLOWED` |


## 限制

- 删除**不可恢复**，没有回收站
- 被删会话的附件、worktree 等关联数据不会被连带清理
- 会话级搜索索引可能残留指向已删日志的条目（不影响正常使用）
- 若后端不是 JSONL（Desktop 默认是），本插件不适用

## 卸载

在插件管理中停用或移除 `dsh-session-delete` 即可，不影响 DSH 本体，也不影响已归档/未归档的任何会话。
