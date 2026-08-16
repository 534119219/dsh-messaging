# DSH Messaging — 重启后验证清单（M0 端到端）

> 前置：手动重启 dsh web（`D:\Harness\restart-dsh-web.ps1`），日志在 `D:\Harness\dsh-web.log`。

## 1. 启动检查（重启后 10 秒内）

日志应依次出现：

```
messaging-core ready (homeChannel=unset)
messaging status endpoint ready at /messaging/status (web server)
platform adapter registered: telegram
platform adapter registered: discord
...（28 个插件各自注册）
telegram: 未配置 token，等待配置（settings messaging-telegram.token）   # 若还没填 token
```

各平台按配置输出 `connected` / `未配置` 之一。**没有 ERROR 堆栈**即为加载成功。

## 2. 设置页检查

浏览器打开 http://127.0.0.1:3080 → 设置 → 左侧应出现「**消息平台**」页：
平台列表（连接状态）、聊天会话列表、刷新按钮。数据源 `/messaging/status`。

## 3. Telegram 端到端（M0 核心）

1. 配置（任选）：
   - `node D:\Harness\messaging\messaging-setup.mjs`（向导，校验 token）；或
   - 手改 `C:\Users\TJ\.dsh\settings.yaml` 的 `messaging-telegram`（token + allowedUsers/allowAll）
2. 填好后**无需重启**：适配器 watch settings 自动连接，日志出现 `telegram connected as @xxx`；
   若未自动连，重启一次。
3. 私聊 bot 发 `你好` → 期望：
   - 立即出现 typing 指示；
   - 消息先出现、随后**流式编辑**（内容逐段刷新）；
   - 最终完整回复（markdown 转 HTML：**加粗**、`代码`、链接可点）。
4. 发送第二条消息（agent 空闲时）→ 同一会话上下文延续（记得上一条内容）。
5. 长任务中发新消息 → 打断（steer）。
6. `/stop` → 回复「⏹ 已中断当前任务」。
7. `/new` → 回复「✅ 已开启新会话」，新问题不再记得旧上下文。
8. 群聊：把 bot 拉进群，`@bot 你好` 或回复 bot 的消息 → 响应；不 @ 不响应。
9. 未授权用户（allowlist 模式下非白名单号）→ 收到「⚠️ 未授权…」。

## 4. 重启恢复（会话持久化）

1. 完成一段对话后**再重启 dsh web**。
2. 重启后给 bot 发消息 → 回复应记得重启前的内容（agent 经 `agents.resume` 恢复，
   chat→session 映射存于 `$DSH_HOME/messaging/session-map.jsonl`）。
3. 若 `/new` 过，重启后仍是新会话 id（`-v1` 后缀）。

## 5. 其他平台快速检查

| 平台 | 检查点 |
|---|---|
| discord | 私聊/频道 @bot；日志 `discord connected as` |
| slack | Socket Mode 应用配置后，DM/频道 @bot |
| wecom / feishu / dingtalk / qq | 对应 WS/长连接日志；回复走各自通道 |
| whatsapp | 首次启用后日志出现配对二维码（ASCII）；扫码后 `whatsapp connected` |
| weixin | `node weixin-pair.mjs` 扫码 → 写入 settings → 自动连接 |
| line / sms / whatsappcloud / teams / googlechat | 公网回调指向 `<公网>/line|sms|whatsapp-cloud|teams|google-chat` |
| api-server | `curl http://127.0.0.1:8765/v1/models`；`curl -X POST .../v1/chat/completions -d '{"messages":[{"role":"user","content":"hi"}]}'` |
| a2a | `curl http://127.0.0.1:8765/.well-known/agent-card.json` |

## 6. 排障

| 症状 | 处理 |
|---|---|
| 日志 `cannot get property "remoteAccess" without inject` | 历史问题（8/15 的 npx 启动），与本插件无关；用 `dsh-web.bat` 启动 |
| 某平台 `connect failed: ...` | 核对 settings 字段名/密钥；看具体错误行 |
| 设置页无「消息平台」 | 浏览器硬刷新（Ctrl+F5）；确认 bundle 已由宿主提供 |
| 收不到消息但已 connected | 群聊需 @提及/回复；allowlist 是否包含你的 id（日志有 `unauthorized` 行） |
| 回复超长被截断 | 按平台上限自动分块（4000/1900/1600…） |
| 改代码不生效 | `powershell -File D:\Harness\messaging\deploy.ps1` 后再重启 |
