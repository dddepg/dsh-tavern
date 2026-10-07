# -*- coding: utf-8 -*-
"""
把 dsh-tavern 导出的 chara_card_v3 转成原版 SillyTavern 可直接导入的卡。

产物：
  <name>-SillyTavern-v2.json   V2 规范（老版 ST 兼容性最好）
  <name>-SillyTavern-v3.json   V3 规范（当前 ST 与 dsh 通用）
  <name>-SillyTavern.png       PNG 卡，同时内嵌 chara(V2) + ccv3(V3) 两个 tEXt 块

兼容性修正（原版 ST 会踩）：
  1. character_book.entries 补 id —— ST 往返时用它做 uid
  2. 空 keys 的条目补 constant:true —— 否则 ST 视为永不触发，设定圣经/文风协议直接失效
  3. 补 selective / secondary_keys / position / extensions 默认值
"""
import json, os, base64, zlib, struct, binascii

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'st-export')
os.makedirs(OUT, exist_ok=True)
SRC = os.path.join(HERE, '_st_export.json')

doc = json.load(open(SRC, encoding='utf-8'))
data = doc['data']
STEM = '催眠小镇·佐藤家（原版）'

# ── 1. 世界书条目规范化 ────────────────────────────────────────────────
book = data.get('character_book') or {}
entries = book.get('entries') or []
fixed = []
for i, e in enumerate(entries):
    keys = list(e.get('keys') or [])
    fixed.append({
        'id': i,
        'keys': keys,
        'secondary_keys': list(e.get('secondary_keys') or []),
        'comment': e.get('comment', ''),
        'name': e.get('comment', ''),
        'content': e.get('content', ''),
        'constant': bool(e.get('constant', False)) or len(keys) == 0,
        'selective': bool(e.get('selective', False)),
        'enabled': bool(e.get('enabled', True)),
        'insertion_order': e.get('insertion_order', 100),
        'priority': e.get('priority', 10),
        'position': e.get('position', 'before_char'),
        'case_sensitive': bool(e.get('case_sensitive', False)),
        'extensions': e.get('extensions') or {},
    })
book = {
    'name': book.get('name', STEM + '设定库'),
    'description': book.get('description', ''),
    'entries': fixed,
    'extensions': book.get('extensions') or {},
}
data['character_book'] = book

# ── 2. V2 / V3 两份 ───────────────────────────────────────────────────
V2_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
             'creator_notes', 'system_prompt', 'post_history_instructions',
             'alternate_greetings', 'character_book', 'tags', 'creator', 'character_version', 'extensions']
v2 = {'spec': 'chara_card_v2', 'spec_version': '2.0',
      'data': {k: data.get(k) for k in V2_FIELDS}}
v2['data']['extensions'] = data.get('extensions') or {}
v3 = {'spec': 'chara_card_v3', 'spec_version': '3.0', 'data': data}

p_v2 = os.path.join(OUT, f'{STEM}-SillyTavern-v2.json')
p_v3 = os.path.join(OUT, f'{STEM}-SillyTavern-v3.json')
json.dump(v2, open(p_v2, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
json.dump(v3, open(p_v3, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

# ── 3. PNG 卡（纯 zlib 生成占位立绘 + tEXt 块）────────────────────────
W, H = 512, 768
def gradient_png():
    rows = bytearray()
    for y in range(H):
        t = y / (H - 1)
        r = int(28 + 150 * t)
        g = int(24 + 70 * t)
        b = int(46 + 40 * t)
        # 中间略亮的柔光，避免死板
        rows.append(0)
        for x in range(W):
            d = 1.0 - abs(x / (W - 1) - 0.5) * 0.55
            rows += bytes((min(255, int(r * d + 18)), min(255, int(g * d + 12)), min(255, int(b * d + 22))))
    def chunk(tag, payload):
        return (struct.pack('>I', len(payload)) + tag + payload
                + struct.pack('>I', binascii.crc32(tag + payload) & 0xffffffff))
    ihdr = struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(bytes(rows), 9)) + chunk(b'IEND', b''))

def text_chunk(keyword, value):
    payload = keyword.encode('latin-1') + b'\x00' + value.encode('latin-1')
    return (struct.pack('>I', len(payload)) + b'tEXt' + payload
            + struct.pack('>I', binascii.crc32(b'tEXt' + payload) & 0xffffffff))

png = gradient_png()
png = png[:-12]  # 去掉 IEND，追加两个 tEXt 块
png += text_chunk('chara', base64.b64encode(json.dumps(v2, ensure_ascii=False).encode('utf-8')).decode('ascii'))
png += text_chunk('ccv3', base64.b64encode(json.dumps(v3, ensure_ascii=False).encode('utf-8')).decode('ascii'))
png += struct.pack('>I', 0) + b'IEND' + struct.pack('>I', binascii.crc32(b'IEND') & 0xffffffff)
p_png = os.path.join(OUT, f'{STEM}-SillyTavern.png')
open(p_png, 'wb').write(png)

# ── 4. 自检：把 PNG 拆回来验 ─────────────────────────────────────────
def read_chunks(buf):
    off, out = 8, []
    while off + 8 <= len(buf):
        ln = struct.unpack('>I', buf[off:off + 4])[0]
        tag = buf[off + 4:off + 8]
        payload = buf[off + 8:off + 8 + ln]
        crc = struct.unpack('>I', buf[off + 8 + ln:off + 12 + ln])[0]
        assert crc == binascii.crc32(tag + payload) & 0xffffffff, f'{tag} CRC 校验失败'
        out.append((tag.decode(), payload))
        off += 12 + ln
        if tag == b'IEND':
            break
    return out

chunks = read_chunks(open(p_png, 'rb').read())
print('PNG 块序:', [t for t, _ in chunks])
found = {}
for tag, payload in chunks:
    if tag != 'tEXt':
        continue
    kw, val = payload.split(b'\x00', 1)
    found[kw.decode()] = val
print('  内嵌块:', sorted(found))
for tag, target in (('chara', v2), ('ccv3', v3)):
    back = json.loads(base64.b64decode(found[tag]).decode('utf-8'))
    ok = json.dumps(back, sort_keys=True, ensure_ascii=False) == json.dumps(target, sort_keys=True, ensure_ascii=False)
    print(f'  {tag}: spec={back["spec"]} 条目={len(back["data"]["character_book"]["entries"])} 往返一致={ok}')

print()
for p in (p_v2, p_v3, p_png):
    print(f'  {os.path.getsize(p):>8,} B  {os.path.basename(p)}')
print()
print('世界书条目（constant=True 的会被原版 ST 恒定注入）:')
for e in fixed:
    print(f'  id={e["id"]} constant={str(e["constant"]):5s} keys={e["keys"]}  {e["comment"]}')
