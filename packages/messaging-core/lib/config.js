/**
 * messaging platform catalog — single source of truth for the setup UI,
 * the host /messaging/config endpoint, and the messaging-setup wizard.
 *
 * field types: 'string' (default) | 'secret' (secret: true) | 'bool' | 'number' | 'list' | 'json'
 */

export const PLATFORM_CATALOG = {
  telegram: {
    label: 'Telegram',
    note: 'token 由 @BotFather 获取；保存后自动连接',
    fields: [
      { key: 'token', label: 'Bot token', env: 'TELEGRAM_BOT_TOKEN', secret: true, required: true },
      { key: 'allowedUsers', label: '允许的 user id（逗号分隔）', type: 'list' },
      { key: 'allowAll', label: '允许所有人（开发用）', type: 'bool', default: false },
    ],
  },
  discord: {
    label: 'Discord',
    note: '开发者后台需开启 MESSAGE CONTENT intent',
    fields: [
      { key: 'token', label: 'Bot token', env: 'DISCORD_BOT_TOKEN', secret: true, required: true },
      { key: 'allowedUsers', label: '允许的 user id（逗号分隔）', type: 'list' },
      { key: 'allowAll', label: '允许所有人', type: 'bool', default: false },
    ],
  },
  slack: {
    label: 'Slack',
    note: '需 Socket Mode + message.im/channels/groups/mpim 事件订阅',
    fields: [
      { key: 'appToken', label: 'App token（xapp-...）', env: 'SLACK_APP_TOKEN', secret: true, required: true },
      { key: 'botToken', label: 'Bot token（xoxb-...）', env: 'SLACK_BOT_TOKEN', secret: true, required: true },
      { key: 'allowedUsers', label: '允许的 user id（逗号分隔）', type: 'list' },
      { key: 'allowAll', label: '允许所有人', type: 'bool', default: false },
    ],
  },
  irc: {
    label: 'IRC',
    fields: [
      { key: 'server', label: '服务器', env: 'IRC_SERVER', required: true },
      { key: 'port', label: '端口', type: 'number', default: 6697 },
      { key: 'useTls', label: 'TLS', type: 'bool', default: true },
      { key: 'nickname', label: '昵称', env: 'IRC_NICKNAME', default: 'dsh-bot' },
      { key: 'channel', label: '频道（如 #general）', env: 'IRC_CHANNEL' },
      { key: 'nickservPassword', label: 'NickServ 密码', secret: true },
    ],
  },
  ntfy: {
    label: 'ntfy',
    note: 'topic+token 即授权',
    fields: [
      { key: 'serverUrl', label: '服务器', default: 'https://ntfy.sh' },
      { key: 'topic', label: '主题', env: 'NTFY_TOPIC', required: true },
      { key: 'token', label: 'Access token（可选）', secret: true },
      { key: 'publishTopic', label: '回复发布主题（默认同订阅）' },
    ],
  },
  email: {
    label: 'Email',
    note: 'IMAP 收 / SMTP 发，按发件人成会话',
    fields: [
      { key: 'imapHost', label: 'IMAP 主机', env: 'EMAIL_IMAP_HOST', required: true },
      { key: 'imapPort', label: 'IMAP 端口', type: 'number', default: 993 },
      { key: 'smtpHost', label: 'SMTP 主机', env: 'EMAIL_SMTP_HOST', required: true },
      { key: 'smtpPort', label: 'SMTP 端口', type: 'number', default: 587 },
      { key: 'address', label: '邮箱地址', env: 'EMAIL_ADDRESS', required: true },
      { key: 'password', label: '密码/应用专用密码', env: 'EMAIL_PASSWORD', secret: true, required: true },
    ],
  },
  matrix: {
    label: 'Matrix',
    fields: [
      { key: 'homeserver', label: 'Homeserver', env: 'MATRIX_HOMESERVER', required: true },
      { key: 'accessToken', label: 'Access token（或下方 user/password）', env: 'MATRIX_ACCESS_TOKEN', secret: true },
      { key: 'user', label: '登录名', env: 'MATRIX_USER' },
      { key: 'password', label: '密码', env: 'MATRIX_PASSWORD', secret: true },
    ],
  },
  homeassistant: {
    label: 'Home Assistant',
    note: '实体状态变化入站，回复为持久通知',
    fields: [
      { key: 'hassUrl', label: 'HA 地址', env: 'HASS_URL', default: 'http://homeassistant.local:8123' },
      { key: 'token', label: '长期访问令牌', env: 'HASS_TOKEN', secret: true, required: true },
      { key: 'entities', label: '监听实体（逗号分隔，空=全部）', type: 'list' },
    ],
  },
  signal: {
    label: 'Signal',
    note: '前置：signal-cli -a <account> daemon --http 127.0.0.1:8080',
    fields: [
      { key: 'httpUrl', label: 'signal-cli HTTP 地址', default: 'http://127.0.0.1:8080' },
      { key: 'account', label: '账号（手机号）', env: 'SIGNAL_ACCOUNT', required: true },
      { key: 'allowedUsers', label: '允许的号码（逗号分隔）', type: 'list' },
    ],
  },
  whatsapp: {
    label: 'WhatsApp',
    note: '扫码配对后即可使用（WhatsApp → 已链接的设备）；非官方协议有封号风险',
    qr: true,
    fields: [
      { key: 'enabled', label: '启用', type: 'bool', default: true },
      { key: 'allowedUsers', label: '允许的手机号（逗号分隔）', type: 'list' },
      { key: 'allowAll', label: '允许所有人', type: 'bool', default: false },
    ],
  },
  feishu: {
    label: '飞书 / Lark',
    note: '应用需 im:message 机器人权限 + 接收消息事件（长连接模式）',
    fields: [
      { key: 'appId', label: 'App ID', env: 'FEISHU_APP_ID', required: true },
      { key: 'appSecret', label: 'App Secret', env: 'FEISHU_APP_SECRET', secret: true, required: true },
    ],
  },
  mattermost: {
    label: 'Mattermost',
    fields: [
      { key: 'url', label: '服务器 URL', env: 'MATTERMOST_URL', required: true },
      { key: 'token', label: 'Bot token', env: 'MATTERMOST_TOKEN', secret: true, required: true },
      { key: 'requireMention', label: '频道需 @提及', type: 'bool', default: true },
    ],
  },
  qq: {
    label: 'QQ 机器人',
    note: '前置：q.qq.com 注册机器人并开通 C2C/群消息 intent；加粗/列表等格式需开通原生 MD（被动 MD 需单独申请）',
    qr: true,
    fields: [
      { key: 'appId', label: 'App ID', env: 'QQ_APP_ID', required: true },
      { key: 'clientSecret', label: 'Client Secret', env: 'QQ_CLIENT_SECRET', secret: true, required: true },
      { key: 'allowedUsers', label: '允许的 user id（逗号分隔）', type: 'list' },
      { key: 'allowAll', label: '允许所有人（开发用）', type: 'bool', default: false },
      { key: 'markdownSupport', label: 'Markdown 格式消息（加粗/列表等）', type: 'bool', default: true },
    ],
  },
  line: {
    label: 'LINE',
    note: '回调路径 /line，需公网可达',
    fields: [
      { key: 'channelAccessToken', label: 'Channel Access Token', secret: true, required: true },
      { key: 'channelSecret', label: 'Channel Secret', secret: true, required: true },
      { key: 'publicUrl', label: '公网回调地址（如 https://bot.example.com）' },
    ],
  },
  sms: {
    label: 'SMS（Twilio）',
    note: '回调路径 /sms，需公网可达',
    fields: [
      { key: 'accountSid', label: 'Account SID', env: 'TWILIO_ACCOUNT_SID', required: true },
      { key: 'authToken', label: 'Auth Token', env: 'TWILIO_AUTH_TOKEN', secret: true, required: true },
      { key: 'phoneNumber', label: 'Twilio 号码', env: 'TWILIO_PHONE_NUMBER', required: true },
    ],
  },
  whatsappcloud: {
    label: 'WhatsApp Cloud',
    note: '回调路径 /whatsapp-cloud，需公网可达',
    fields: [
      { key: 'token', label: 'Meta 永久 token', secret: true, required: true },
      { key: 'appSecret', label: 'App Secret', secret: true, required: true },
      { key: 'verifyToken', label: 'Webhook verify token', required: true },
    ],
  },
  wecom: {
    label: '企业微信 AI Bot',
    note: 'WS 网关模式，无需公网',
    fields: [
      { key: 'botId', label: 'Bot ID', env: 'WECOM_BOT_ID', required: true },
      { key: 'secret', label: 'Secret', env: 'WECOM_SECRET', secret: true, required: true },
    ],
  },
  teams: {
    label: 'Microsoft Teams',
    note: '回调路径 /teams，生产需 HTTPS；前置 Azure Bot 资源',
    fields: [
      { key: 'clientId', label: 'Entra Client ID', env: 'TEAMS_CLIENT_ID', required: true },
      { key: 'clientSecret', label: 'Client Secret', env: 'TEAMS_CLIENT_SECRET', secret: true, required: true },
      { key: 'tenantId', label: 'Tenant ID' },
      { key: 'publicUrl', label: '公网回调地址' },
    ],
  },
  dingtalk: {
    label: '钉钉（Stream）',
    note: '企业内部应用 + Stream 模式机器人',
    fields: [
      { key: 'clientId', label: 'AppKey', env: 'DINGTALK_CLIENT_ID', required: true },
      { key: 'clientSecret', label: 'AppSecret', env: 'DINGTALK_CLIENT_SECRET', secret: true, required: true },
    ],
  },
  googlechat: {
    label: 'Google Chat',
    note: '回调路径 /google-chat，需公网可达',
    fields: [
      { key: 'serviceAccountJson', label: '服务账号 JSON', secret: true, required: true },
      { key: 'botDisplayName', label: 'Bot 显示名（群 @提及 用）' },
    ],
  },
  webhook: {
    label: '通用 Webhook',
    note: 'routes 为 JSON 数组：[{"path":"/github","secret":"s","prompt":"处理 {{payload}}","deliverUrl":""}]',
    fields: [
      { key: 'routes', label: '路由配置 JSON', type: 'json', default: [] },
    ],
  },
  a2a: {
    label: 'A2A',
    note: 'GET /.well-known/agent-card.json + POST /a2a',
    fields: [
      { key: 'agentName', label: 'Agent 名', default: 'DSH Agent' },
      { key: 'bearerToken', label: 'Bearer token（空=仅回环）', secret: true },
    ],
  },
  weixin: {
    label: '微信个人号（iLink）',
    note: '点击"扫码授权"用微信扫码自动配对；非官方协议有风险',
    qr: true,
    fields: [
      { key: 'accountId', label: 'Account ID', env: 'WEIXIN_ACCOUNT_ID' },
      { key: 'token', label: 'Token', env: 'WEIXIN_TOKEN', secret: true },
    ],
  },
  bluebubbles: {
    label: 'BlueBubbles (iMessage)',
    note: '前置：macOS BlueBubbles 服务端 + helper',
    fields: [
      { key: 'serverUrl', label: '服务器 URL', env: 'BLUEBUBBLES_SERVER_URL', required: true },
      { key: 'password', label: '服务器密码', env: 'BLUEBUBBLES_PASSWORD', secret: true, required: true },
      { key: 'webhookUrl', label: '本机可达回调 URL' },
    ],
  },
  'api-server': {
    label: 'OpenAI 兼容 API Server',
    note: 'POST /v1/chat/completions + GET /v1/models；会话延续用 X-DSH-Session-Id 头',
    fields: [
      { key: 'apiToken', label: 'Bearer token（空=仅回环）', env: 'DSH_API_TOKEN', secret: true },
      { key: 'modelName', label: '模型名', default: 'dsh-agent' },
    ],
  },
  yuanbao: {
    label: '腾讯元宝',
    fields: [
      { key: 'appKey', label: 'App Key', env: 'YUANBAO_APP_KEY', required: true },
      { key: 'appSecret', label: 'App Secret', env: 'YUANBAO_APP_SECRET', secret: true, required: true },
    ],
  },
  simplex: {
    label: 'SimpleX',
    note: '前置：simplex-chat -p 5225',
    fields: [
      { key: 'wsUrl', label: 'Daemon WS URL', env: 'SIMPLEX_WS_URL', default: 'ws://127.0.0.1:5225' },
      { key: 'autoAccept', label: '自动接受联系请求', type: 'bool', default: true },
      { key: 'groupAllowed', label: '允许的群（逗号分隔，* = 任意）', type: 'list' },
    ],
  },
}
