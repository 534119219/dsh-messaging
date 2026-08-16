/**
 * Model-facing messaging tools: `send_message` (proactive sends to any
 * connected platform chat) and `messaging_status` (platform/session overview).
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderForCapability } from './markdown.js'

export function registerMessagingTools(ctx, { adapters, sessionMap }) {
  ctx.tools.register(defineTool({
    name: 'send_message',
    description: '通过已连接的消息平台向指定聊天发送一条消息（如 Telegram）。platform 取值见 messaging_status 返回的 platforms[].id；chat 为目标聊天 id（数字字符串）。',
    parameters: {
      platform: { type: 'string', required: true, description: '平台 id，如 telegram' },
      chat: { type: 'string', required: true, description: '目标聊天 id（数字字符串）' },
      text: { type: 'string', required: true, description: '要发送的文本内容' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: value && value.ok
          ? `消息已发送至 ${value.platform}/${value.chat}${value.messageId ? `（messageId=${value.messageId}）` : ''}`
          : `发送失败：${value ? value.reason : '未知错误'}`,
      }],
    },
    async execute(args) {
      const adapter = adapters.get(args.platform)
      if (!adapter) {
        return { ok: false, platform: args.platform, chat: args.chat, reason: `未知平台 ${args.platform}` }
      }
      try {
        const rendered = renderForCapability(String(args.text), adapter.capabilities)
        const result = await adapter.send({ chatId: String(args.chat) }, rendered)
        return { ok: true, platform: args.platform, chat: String(args.chat), messageId: result && result.messageId ? result.messageId : null }
      } catch (error) {
        return { ok: false, platform: args.platform, chat: String(args.chat), reason: String(error && error.message ? error.message : error) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'messaging_status',
    description: '列出已连接的消息平台、各平台聊天会话与最近活跃时间。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute() {
      const platforms = [...adapters.values()].map((adapter) => ({
        id: adapter.id,
        connected: Boolean(adapter.connected),
      }))
      const chats = sessionMap.entries().map((entry) => ({
        platform: entry.chatKey.split(':')[0],
        chatId: entry.chatId,
        userName: entry.userName,
        sessionId: entry.sessionId,
        updatedAt: entry.updatedAt,
      }))
      return { platforms, chats }
    },
  }))
}
