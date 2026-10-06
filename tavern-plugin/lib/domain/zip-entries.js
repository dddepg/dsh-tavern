import path from 'node:path'
import { inflateRawSync } from 'node:zlib'

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_EXPANDED_BYTES = 150 * 1024 * 1024
const MAX_ENTRIES = 10000

function findEndOfCentralDirectory(buffer, fail, label) {
  const minimum = Math.max(0, buffer.length - 65557)
  for (let offset = buffer.length - 22; offset >= minimum; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  fail('文件不是有效的 ' + (label === 'ZIP' ? 'ZIP' : label + '/ZIP'))
}

/** Read a plain ZIP into path → bytes. Caller-provided fail() owns the error wording. */
export function readZipEntries(input, { label = 'ZIP', fail = message => { throw new Error(label + ' 解析失败：' + message) } } = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buffer.length === 0) fail('文件为空')
  if (buffer.length > MAX_ARCHIVE_BYTES) fail('文件超过 50 MB')
  const eocd = findEndOfCentralDirectory(buffer, fail, label)
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  let offset = buffer.readUInt32LE(eocd + 16)
  if (entryCount === 0xffff || centralSize === 0xffffffff || offset === 0xffffffff) fail('不支持 ZIP64 ' + label)
  if (entryCount > MAX_ENTRIES) fail('压缩包文件数量过多')
  if (offset + centralSize > buffer.length) fail('中央目录越界')

  const entries = new Map()
  let expanded = 0
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) fail('中央目录损坏')
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const nameEnd = offset + 46 + nameLength
    if (nameEnd + extraLength + commentLength > buffer.length) fail('文件目录损坏')
    const name = buffer.subarray(offset + 46, nameEnd).toString('utf8').replace(/\\/g, '/')
    offset = nameEnd + extraLength + commentLength
    if (name.endsWith('/')) continue
    if ((flags & 1) !== 0) fail(label + ' 包含加密文件')
    if (method !== 0 && method !== 8) fail('包含不支持的压缩格式')
    expanded += uncompressedSize
    if (expanded > MAX_EXPANDED_BYTES) fail('解压后内容超过 150 MB')
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) fail('本地文件头损坏')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) fail('压缩内容越界')
    const compressed = buffer.subarray(dataStart, dataEnd)
    const data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: uncompressedSize + 1 })
    if (data.length !== uncompressedSize) fail('解压长度不一致')
    entries.set(path.posix.normalize(name), data)
  }
  return entries
}
