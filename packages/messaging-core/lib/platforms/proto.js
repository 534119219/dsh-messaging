/**
 * yuanbao proto — JS port of hermes-agent's gateway/platforms/yuanbao_proto.py.
 *
 * Wire layout per WS frame:
 *   ConnMsg (protobuf) { Head head = 1; bytes data = 2; }
 *   Head { uint32 cmd_type=1; string cmd=2; uint32 seq_no=3; string msg_id=4;
 *          string module=5; bool need_ack=6; int32 status=10; }
 *   data is the biz payload (InboundMessagePush / SendC2CMessageReq /
 *   SendGroupMessageReq / ...), also standard protobuf.
 */

// ---- wire types ----
export const WT_VARINT = 0
export const WT_64BIT = 1
export const WT_LEN = 2
export const WT_32BIT = 5

// ---- enums ----
export const CMD_TYPE = { Request: 0, Response: 1, Push: 2, PushAck: 3 }
export const CMD = { AuthBind: 'auth-bind', Ping: 'ping', Kickout: 'kickout', UpdateMeta: 'update-meta' }
export const MODULE = { ConnAccess: 'conn_access' }
export const BIZ_PKG = 'yuanbao_openclaw_proxy'
export const HERMES_INSTANCE_ID = 17

// ---- varint ----
export function encodeVarint(value) {
  let v = value < 0 ? BigInt.asUintN(64, BigInt(value)) : BigInt(value)
  const out = []
  for (;;) {
    const bits = Number(v & 0x7fn)
    v >>= 7n
    if (v !== 0n) out.push(bits | 0x80)
    else {
      out.push(bits)
      break
    }
  }
  return Buffer.from(out)
}

export function decodeVarint(data, pos) {
  let result = 0n
  let shift = 0n
  while (pos < data.length) {
    const b = data[pos]
    pos += 1
    result |= BigInt(b & 0x7f) << shift
    shift += 7n
    if (!(b & 0x80)) break
    if (shift >= 64n) throw new Error('varint too long')
  }
  return [Number(result), pos]
}

// ---- field helpers ----
export function encodeField(fieldNumber, wireType, value) {
  const tag = encodeVarint((fieldNumber << 3) | wireType)
  return Buffer.concat([tag, value])
}

export function encodeString(s) {
  const encoded = Buffer.from(String(s), 'utf8')
  return Buffer.concat([encodeVarint(encoded.length), encoded])
}

export function encodeBytes(b) {
  return Buffer.concat([encodeVarint(b.length), b])
}

export function encodeMessage(b) {
  return Buffer.concat([encodeVarint(b.length), b])
}

export function parseFields(data) {
  const fields = []
  let pos = 0
  const n = data.length
  while (pos < n) {
    const [tag, p1] = decodeVarint(data, pos)
    pos = p1
    const fieldNumber = tag >> 3
    const wireType = tag & 0x07
    if (wireType === WT_VARINT) {
      const [val, p2] = decodeVarint(data, pos)
      pos = p2
      fields.push([fieldNumber, wireType, val])
    } else if (wireType === WT_LEN) {
      const [length, p2] = decodeVarint(data, pos)
      pos = p2
      fields.push([fieldNumber, wireType, data.subarray(pos, pos + length)])
      pos += length
    } else if (wireType === WT_64BIT) {
      fields.push([fieldNumber, wireType, data.subarray(pos, pos + 8)])
      pos += 8
    } else if (wireType === WT_32BIT) {
      fields.push([fieldNumber, wireType, data.subarray(pos, pos + 4)])
      pos += 4
    } else {
      throw new Error(`unknown wire type ${wireType}`)
    }
  }
  return fields
}

function fieldsToDict(fields) {
  const d = new Map()
  for (const [fn, wt, val] of fields) {
    if (!d.has(fn)) d.set(fn, [])
    d.get(fn).push([wt, val])
  }
  return d
}

function getString(fdict, fn, def = '') {
  const entries = fdict.get(fn)
  if (!entries) return def
  const [wt, val] = entries[0]
  if (wt === WT_LEN && Buffer.isBuffer(val)) return val.toString('utf8')
  return def
}

function getVarint(fdict, fn, def = 0) {
  const entries = fdict.get(fn)
  if (!entries) return def
  const [wt, val] = entries[0]
  if (wt === WT_VARINT && typeof val === 'number') return val
  return def
}

function getBytes(fdict, fn) {
  const entries = fdict.get(fn)
  if (!entries) return Buffer.alloc(0)
  const [wt, val] = entries[0]
  if (wt === WT_LEN && Buffer.isBuffer(val)) return val
  return Buffer.alloc(0)
}

function getRepeatedBytes(fdict, fn) {
  const entries = fdict.get(fn)
  if (!entries) return []
  return entries.filter(([wt]) => wt === WT_LEN).map(([, val]) => val)
}

// ---- seq ----
let seqCounter = 0
const SEQ_MAX = 0xffffffff
export function nextSeqNo() {
  seqCounter = (seqCounter + 1) & SEQ_MAX
  return seqCounter
}

// ---- Head ----
export function encodeHead(cmdType, cmd, seqNo, msgId, module, needAck = false, status = 0) {
  let buf = Buffer.alloc(0)
  if (cmdType !== 0) buf = Buffer.concat([buf, encodeField(1, WT_VARINT, encodeVarint(cmdType))])
  if (cmd) buf = Buffer.concat([buf, encodeField(2, WT_LEN, encodeString(cmd))])
  if (seqNo !== 0) buf = Buffer.concat([buf, encodeField(3, WT_VARINT, encodeVarint(seqNo))])
  if (msgId) buf = Buffer.concat([buf, encodeField(4, WT_LEN, encodeString(msgId))])
  if (module) buf = Buffer.concat([buf, encodeField(5, WT_LEN, encodeString(module))])
  if (needAck) buf = Buffer.concat([buf, encodeField(6, WT_VARINT, encodeVarint(1))])
  if (status !== 0) buf = Buffer.concat([buf, encodeField(10, WT_VARINT, encodeVarint(status))])
  return buf
}

export function decodeHead(data) {
  const fdict = fieldsToDict(parseFields(data))
  return {
    cmd_type: getVarint(fdict, 1, 0),
    cmd: getString(fdict, 2, ''),
    seq_no: getVarint(fdict, 3, 0),
    msg_id: getString(fdict, 4, ''),
    module: getString(fdict, 5, ''),
    need_ack: Boolean(getVarint(fdict, 6, 0)),
    status: getVarint(fdict, 10, 0),
  }
}

// ---- ConnMsg ----
export function encodeConnMsgFull(cmdType, cmd, seqNo, msgId, module, data, needAck = false) {
  const headBytes = encodeHead(cmdType, cmd, seqNo, msgId, module, needAck)
  let buf = encodeField(1, WT_LEN, encodeMessage(headBytes))
  if (data && data.length) buf = Buffer.concat([buf, encodeField(2, WT_LEN, encodeBytes(data))])
  return buf
}

export function decodeConnMsg(data) {
  const fdict = fieldsToDict(parseFields(data))
  const headBytes = getBytes(fdict, 1)
  const payload = getBytes(fdict, 2)
  const head = headBytes.length ? decodeHead(headBytes) : { cmd_type: 0, cmd: '', seq_no: 0, msg_id: '', module: '', need_ack: false, status: 0 }
  return { msg_type: head.cmd_type, seq_no: head.seq_no, data: payload, head }
}

function encodeBizMsg(service, method, reqId, body) {
  return encodeConnMsgFull(CMD_TYPE.Request, method, nextSeqNo(), reqId, service, body)
}

// ---- MsgContent / MsgBodyElement ----
export function encodeMsgContentText(text) {
  return encodeField(1, WT_LEN, encodeString(text))
}

export function encodeMsgBodyElement(msgType, msgContentBytes) {
  let buf = Buffer.alloc(0)
  if (msgType) buf = Buffer.concat([buf, encodeField(1, WT_LEN, encodeString(msgType))])
  if (msgContentBytes && msgContentBytes.length) buf = Buffer.concat([buf, encodeField(2, WT_LEN, encodeMessage(msgContentBytes))])
  return buf
}

// ---- outbound send ----
export function encodeSendC2CMessage(toAccount, fromAccount, text, msgId, msgRandom = 0, msgSeq = 0, groupCode = '', traceId = '') {
  let buf = Buffer.alloc(0)
  if (msgId) buf = Buffer.concat([buf, encodeField(1, WT_LEN, encodeString(msgId))])
  buf = Buffer.concat([buf, encodeField(2, WT_LEN, encodeString(toAccount))])
  if (fromAccount) buf = Buffer.concat([buf, encodeField(3, WT_LEN, encodeString(fromAccount))])
  if (msgRandom) buf = Buffer.concat([buf, encodeField(4, WT_VARINT, encodeVarint(msgRandom))])
  const element = encodeMsgBodyElement('TIMTextElem', encodeMsgContentText(text))
  buf = Buffer.concat([buf, encodeField(5, WT_LEN, encodeMessage(element))])
  if (groupCode) buf = Buffer.concat([buf, encodeField(6, WT_LEN, encodeString(groupCode))])
  if (msgSeq) buf = Buffer.concat([buf, encodeField(7, WT_VARINT, encodeVarint(msgSeq))])
  if (traceId) {
    const logBytes = encodeField(1, WT_LEN, encodeString(traceId))
    buf = Buffer.concat([buf, encodeField(8, WT_LEN, encodeMessage(logBytes))])
  }
  const reqId = msgId || `c2c_${nextSeqNo()}`
  return encodeConnMsgFull(CMD_TYPE.Request, 'send_c2c_message', nextSeqNo(), reqId, BIZ_PKG, buf)
}

export function encodeSendGroupMessage(groupCode, fromAccount, text, msgId, msgSeq = 0) {
  let buf = Buffer.alloc(0)
  if (msgId) buf = Buffer.concat([buf, encodeField(1, WT_LEN, encodeString(msgId))])
  buf = Buffer.concat([buf, encodeField(2, WT_LEN, encodeString(groupCode))])
  if (fromAccount) buf = Buffer.concat([buf, encodeField(3, WT_LEN, encodeString(fromAccount))])
  const element = encodeMsgBodyElement('TIMTextElem', encodeMsgContentText(text))
  buf = Buffer.concat([buf, encodeField(6, WT_LEN, encodeMessage(element))])
  if (msgSeq) buf = Buffer.concat([buf, encodeField(8, WT_VARINT, encodeVarint(msgSeq))])
  const reqId = msgId || `grp_${nextSeqNo()}`
  return encodeConnMsgFull(CMD_TYPE.Request, 'send_group_message', nextSeqNo(), reqId, BIZ_PKG, buf)
}

// ---- auth / ping / ack ----
export function encodeAuthBind({ bizId, uid, source, token, msgId, appVersion = '', operationSystem = '', botVersion = '', routeEnv = '', instanceId = HERMES_INSTANCE_ID }) {
  const authBuf = Buffer.concat([
    encodeField(1, WT_LEN, encodeString(uid)),
    encodeField(2, WT_LEN, encodeString(source)),
    encodeField(3, WT_LEN, encodeString(token)),
  ])
  let devBuf = Buffer.alloc(0)
  if (appVersion) devBuf = Buffer.concat([devBuf, encodeField(1, WT_LEN, encodeString(appVersion))])
  if (operationSystem) devBuf = Buffer.concat([devBuf, encodeField(2, WT_LEN, encodeString(operationSystem))])
  devBuf = Buffer.concat([devBuf, encodeField(10, WT_LEN, encodeString(String(instanceId)))])
  if (botVersion) devBuf = Buffer.concat([devBuf, encodeField(24, WT_LEN, encodeString(botVersion))])
  let reqBuf = Buffer.concat([
    encodeField(1, WT_LEN, encodeString(bizId)),
    encodeField(2, WT_LEN, encodeMessage(authBuf)),
    encodeField(3, WT_LEN, encodeMessage(devBuf)),
  ])
  if (routeEnv) reqBuf = Buffer.concat([reqBuf, encodeField(5, WT_LEN, encodeString(routeEnv))])
  return encodeConnMsgFull(CMD_TYPE.Request, CMD.AuthBind, nextSeqNo(), msgId, MODULE.ConnAccess, reqBuf)
}

export function encodePing(msgId) {
  return encodeConnMsgFull(CMD_TYPE.Request, CMD.Ping, nextSeqNo(), msgId, MODULE.ConnAccess, Buffer.alloc(0))
}

export function encodePushAck(originalHead) {
  return encodeConnMsgFull(CMD_TYPE.PushAck, originalHead.cmd || '', nextSeqNo(), originalHead.msg_id || '', originalHead.module || '', Buffer.alloc(0))
}

// ---- inbound push ----
/** AuthBindRsp: field 1 code (varint), field 2 message, field 3 connect_id. */
export function decodeAuthBindRsp(data) {
  const fdict = fieldsToDict(parseFields(data))
  return { code: getVarint(fdict, 1, -1), message: getString(fdict, 2), connect_id: getString(fdict, 3) }
}

export function decodeInboundPush(data) {
  try {
    const fdict = fieldsToDict(parseFields(data))
    const msgBody = []
    for (const elBytes of getRepeatedBytes(fdict, 13)) {
      const ef = fieldsToDict(parseFields(elBytes))
      const msgType = getString(ef, 1, '')
      const contentBytes = getBytes(ef, 2)
      const content = contentBytes.length ? decodeMsgContent(contentBytes) : {}
      msgBody.push({ msg_type: msgType, msg_content: content })
    }
    return {
      callback_command: getString(fdict, 1),
      from_account: getString(fdict, 2),
      to_account: getString(fdict, 3),
      sender_nickname: getString(fdict, 4),
      group_id: getString(fdict, 5),
      group_code: getString(fdict, 6),
      group_name: getString(fdict, 7),
      msg_seq: getVarint(fdict, 8),
      msg_random: getVarint(fdict, 9),
      msg_time: getVarint(fdict, 10),
      msg_key: getString(fdict, 11),
      msg_id: getString(fdict, 12),
      msg_body: msgBody,
      cloud_custom_data: getString(fdict, 14),
      event_time: getVarint(fdict, 15),
      bot_owner_id: getString(fdict, 16),
      claw_msg_type: getVarint(fdict, 18),
      private_from_group_code: getString(fdict, 19),
      trace_id: (() => {
        const logExt = getBytes(fdict, 20)
        if (!logExt.length) return ''
        const lf = fieldsToDict(parseFields(logExt))
        return getString(lf, 1, '')
      })(),
    }
  } catch {
    return null
  }
}

function decodeMsgContent(data) {
  const fdict = fieldsToDict(parseFields(data))
  const content = {}
  const text = getString(fdict, 1)
  if (text) content.text = text
  const uuid = getString(fdict, 2)
  if (uuid) content.uuid = uuid
  const url = getString(fdict, 10)
  if (url) content.url = url
  return content
}
