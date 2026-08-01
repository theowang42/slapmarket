import zlib from 'node:zlib';

// xlsx 就是个 zip 包着几个 XML。只要读两个表就够了，为此装依赖不值当，
// 这里手写一个够用的最小解析：ZIP 中央目录 → inflate → 极简 XML 扫描。

/** 读 ZIP 中央目录，返回 { 文件名: 解压后的 Buffer }。 */
function unzip(buf) {
  // 从尾部找 EOCD（0x06054b50）。注释区最长 64K。
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是合法的 zip：找不到中央目录');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // 局部头的长度字段在流式写入时会是 0，所以尺寸一律以中央目录为准
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescapeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, '&');

/** 取出片段里所有 <t> 文本并拼接。 */
const textOf = (xml) => [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');

/**
 * sharedStrings 必须按 <si> 逐项解析：带富文本的条目内部有多个 <t>，
 * 直接按 <t> 平铺会让后面所有索引整体错位。
 */
const sharedStrings = (xml) => [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));

/** A1 → 0，B1 → 1，AA1 → 26 */
function colIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * 解析 xlsx 的第一张表，返回二维字符串数组。
 * 只处理共享字符串、内联字符串和数字这三种单元格，SSGA 的持仓表用不到别的。
 */
export function parseXlsx(buffer) {
  const files = unzip(buffer);
  const sheetName = Object.keys(files).find((f) => /^xl\/worksheets\/sheet1\.xml$/.test(f))
    ?? Object.keys(files).find((f) => /^xl\/worksheets\/.*\.xml$/.test(f));
  if (!sheetName) throw new Error('xlsx 里没有找到工作表');

  const shared = files['xl/sharedStrings.xml'] ? sharedStrings(files['xl/sharedStrings.xml'].toString('utf8')) : [];
  const sheet = files[sheetName].toString('utf8');
  const rows = [];

  for (const rm of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c\s([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1], inner = cm[2];
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      let value = '';
      if (type === 's') {
        const i = +(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? -1);
        value = shared[i] ?? '';
      } else if (type === 'inlineStr') {
        value = textOf(inner);
      } else {
        value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
      }
      cells[ref ? colIndex(ref) : cells.length] = value;
    }
    rows.push([...cells].map((v) => v ?? ''));
  }
  return rows;
}
