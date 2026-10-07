# -*- coding: utf-8 -*-
"""
把 dsh-tavern 实例里的「催眠小镇·佐藤家（原版） MVU版本」工作区卡，
转成原版 SillyTavern（+ 酒馆助手/MagVarUpdate 生态）可直接导入的角色卡。

格式参照酒馆导出的《催眠小镇·全角色》（chara_card_v3 + tavern_helper MVU 脚本）。

转换要点：
  1. 世界书条目规范化：补 id / constant / selective / position / extensions 完整字段，
     恒定条目挂 @D0（extensions.position=4, depth=0），关键词条目挂角色定义后（position=1）。
  2. DSH 原生 MVU（dsh_mvu_conversion + mvu_submit_update 工具调用）→ MagVarUpdate 生态：
     - [initvar]变量初始化：YAML，取自 initialState（清晨开局），enabled=false 由脚本读取
     - [mvu_update]变量更新规则 / [mvu_update]变量输出格式：JSONPatch 输出协议，enabled=false 由脚本注入
     - 变量列表：{{format_message_variable::stat_data}} 注入当前变量快照
     - tavern_helper.scripts：MagVarUpdate bundle + MVU Zod schema（含初始值 prefault）
  3. 三条开场白剥掉 <initvar>JSON 块与 <mvu-status/> 标记（DSH 专用渲染，ST 下无法工作）；
     午后/深夜两条备用开场白按各自的 openingState 与基底的差值，末尾内嵌
     <UpdateVariable> _.set(...) 开局覆盖块（MagVarUpdate 开局机制，在 [InitVar] 基础上覆盖，
     参考 MagVarUpdate doc/tutorial.md「根据开局设置变量初始值」）。
  4. 去掉 regex_scripts / dsh_mvu_conversion 等 DSH 专有扩展。

产物（st-export/）：v2 json / v3 json / PNG 卡（内嵌 chara + ccv3 两个 tEXt 块）。
"""
import json, os, sys, base64, zlib, struct, binascii, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'st-export')
os.makedirs(OUT, exist_ok=True)

SRC = sys.argv[1] if len(sys.argv) > 1 else (
    '/home/ezio/workspace/dsh-tavern-cli/profile-data/tavern/data/resources/cards/'
    '催眠小镇·佐藤家（原版） MVU版本.json')
STEM = '催眠小镇·佐藤家（原版） MVU版本'
BOOK_NAME = '催眠小镇_佐藤家MVU'

doc = json.load(open(SRC, encoding='utf-8'))
src = doc['raw']['data']
conv = src['extensions']['dsh_mvu_conversion']['definition']
initial = conv['initialState']

# ── 1. 世界书条目 ─────────────────────────────────────────────────────
CONST_DEPTH = {'position': 4, 'depth': 0}    # 恒定条目：@D0
KEYED_POS = {'position': 1, 'depth': 4}      # 关键词条目：角色定义后

def entry_ext(idx, pos, depth):
    return {
        'position': pos, 'exclude_recursion': False, 'display_index': idx,
        'probability': 100, 'useProbability': True, 'depth': depth,
        'selectiveLogic': 0, 'outlet_name': '', 'group': '',
        'group_override': False, 'group_weight': 100,
        'prevent_recursion': False, 'delay_until_recursion': False,
        'scan_depth': None, 'match_whole_words': None, 'use_group_scoring': False,
        'case_sensitive': None, 'automation_id': '', 'role': 0, 'vectorized': False,
        'sticky': 0, 'cooldown': 0, 'delay': 0,
        'match_persona_description': False, 'match_character_description': False,
        'match_character_personality': False, 'match_character_depth_prompt': False,
        'match_scenario': False, 'match_creator_notes': False,
        'triggers': [], 'ignore_budget': False,
    }

def story_entry(i, e):
    keys = list(e.get('keys') or [])
    constant = bool(e.get('constant', False)) or len(keys) == 0
    pos, depth = (CONST_DEPTH if constant else KEYED_POS).values()
    return {
        'id': i,
        'keys': keys,
        'secondary_keys': list(e.get('secondary_keys') or []),
        'comment': e.get('comment', ''),
        'content': e.get('content', ''),
        'constant': constant,
        'selective': True,
        'insertion_order': e.get('insertion_order', 100),
        'enabled': bool(e.get('enabled', True)),
        'position': 'after_char',
        'use_regex': True,
        'extensions': entry_ext(i, pos, depth),
    }

stories = [e for e in src['character_book']['entries']
           if not (e.get('comment') or '').startswith(('[initvar]', '[mvu_update]'))]

UPDATE_RULES = '''变量更新规则:
  环境:
    日期:
      format: yyyy-MM-DD HH:mm
      check:
        - 每次对话或场景转换后根据正文中实际经历的时间自然推进
        - 休息、外出、午睡、洗浴、过夜等应有合理的时间流逝；跨度较大时在叙述中交代
  全镇常识异化:
    check:
      - 记录小镇居民常识改写的当前状态：阶段0~2 维持「表面如常、被{{user}}需要时自然配合」
      - 阶段3 及涉及外部NPC时，明确镇民视佐藤家一切暴露、调教与侍奉为理所当然的家庭情趣，自然让位、绝无丑闻
  角色.${角色名}:
    type: |-
      {
        催眠深度: number; // 整数0-100，必须与当前阶段处于同一区间：阶段0→0-24；阶段1→25-49；阶段2→50-74；阶段3→75-100；仅当正文中确实发生了催眠暗示、常识微调或认知改写时才上调，单次通常 +3~+10，重大突破方可更大
        当前位置: string; // 角色所处地点，随移动实时更新；外出时写明镇上具体场所（如镇上旧书店、商店街、购物中心、温泉）
        当前穿着: string; // 角色当下的实际着装，随换装、洗浴、就寝、阶段演变更新（美咲的围裙始终不变、变的是围裙底下；优奈从宽大T恤逐步转向露腰短衫与吊袜带）
        当前设置的额外人设: string; // ★仅由{{user}}在对话中明确指令时修改，AI 绝不擅自更改；正常对话保持初始值「（留空——仅{{user}}可临时设定，默认按自身人设行动）」；严禁将当前动作、进行中的行为或短暂情绪写入
        当前阶段: number; // 整数0-3，严格对应「四阶段心智篡夺与玩偶觉醒体系」，不得跳阶段、不得回退
        心理防线: string; // 一句话概括该角色此刻的内心状态与防线位置，随阶段与场景同步更新
        瞳色: string; // 美咲由「清澈浅蓝」逐步转向「紫红」；优奈由「琥珀棕」逐步转向「紫粉」；阶段0保持原色、阶段1偶泛异色、阶段2明显偏紫、阶段3完全转化
        阶段名称: string; // 与当前阶段同步：0=寻常夏日与客气防线；1=常识微调与正当化借口；2=常识置换与伪家人确立；3=玩偶觉醒与角色扮演
      }
    check:
      - 仅包含当前场景中出现的角色（不包含{{user}}）
      - 母女二人各自独立推进，可以处于不同阶段与深度
      - 催眠深度越过区间边界时，当前阶段与阶段名称必须同步推进，两者永远保持一致
  临时变量:
    check: 出现美咲、优奈之外的新人物时写入（姓名／身份／一句话定位），该人物退场后删除'''

OUTPUT_FORMAT = '''变量输出格式:
  rule:
    - you should output the update analysis and the actual update commands in the end of the next reply
    - the update commands must strictly follow the **JSON Patch (RFC 6902)** standard; that is, the output must be a valid JSON array containing operation objects
  format: |-
    <UpdateVariable>
    <Analysis>$(IN ENGLISH, no more than 80 words)
    - ${calculate time passed: ...}
    - ${decide whether dramatic updates are allowed as it's in a special case or the time passed is more than usual: yes/no}
    - ${analyze every variable based on its corresponding `check`, according only to current reply instead of previous plots: ...}
    </Analysis>
    <JSONPatch>
    [
      { "op": "replace", "path": "${/path/to/variable}", "value": "${new_value}" },
      { "op": "add", "path": "${/path/to/array/-}", "value": "${item_to_append}" },
      { "op": "add", "path": "${/path/to/object/newKey}", "value": "${content}" }
      { "op": "move", "from": "${/source/list/0}", "path": "${/dest/list/-}" },
      { "op": "remove", "path": "${/path/to/array/0}" },
      ...
    ]
    </JSONPatch>
    </UpdateVariable>'''

def yaml_initvar(state):
    def q(v):
        return "'" + str(v).replace("'", "''") + "'"
    lines = []
    lines.append('临时变量: ' + q(state['临时变量']))
    lines.append('全镇常识异化: ' + q(state['全镇常识异化']))
    lines.append('环境:')
    lines.append('  日期: ' + q(state['环境']['日期']))
    lines.append('角色:')
    for name, fields in state['角色'].items():
        lines.append(f'  {name}:')
        for k, v in fields.items():
            lines.append(f'    {k}: ' + (str(v) if isinstance(v, (int, float)) else q(v)))
    return '\n'.join(lines)

def mvu_entry(i, comment, content, order, depth):
    return {
        'id': i, 'keys': [], 'secondary_keys': [], 'comment': comment,
        'content': content, 'constant': True, 'selective': True,
        'insertion_order': order, 'enabled': False, 'position': 'after_char',
        'use_regex': True, 'extensions': entry_ext(i, 4, depth),
    }

VARIABLE_LIST = ('<status_current_variable>\n'
                 '{{format_message_variable::stat_data}}\n'
                 '</status_current_variable>')

entries = [story_entry(i, e) for i, e in enumerate(stories)]
n = len(entries)
entries.append(story_entry(n, {'comment': '变量列表', 'keys': [], 'content': VARIABLE_LIST,
                               'constant': True, 'insertion_order': 1, 'enabled': True}))
entries.append(mvu_entry(n + 1, '[initvar]变量初始化', yaml_initvar(initial), 100, 0))
entries.append(mvu_entry(n + 2, '[mvu_update]变量更新规则', UPDATE_RULES, 3, 1))
entries.append(mvu_entry(n + 3, '[mvu_update]变量输出格式', OUTPUT_FORMAT, 4, 1))

book = {
    'name': BOOK_NAME,
    'description': '催眠小镇·佐藤家（原版）MVU版本设定库：设定圣经、四阶段心智篡夺机制、母女瓦解轨迹、'
                   '暑假作息与宅邸动线、全镇常识异化共识，以及 MVU 变量初始化与更新协议。',
    'entries': entries,
}

# ── 2. 开场白：剥掉 <initvar> 块与 <mvu-status/> 标记，按开局差值内嵌覆盖块 ──
import re
MARKER = re.compile(r'<initvar>[\s\S]*?<mvu-status\s*/>')

def js_obj(v):
    return json.dumps(v, ensure_ascii=False)

openings = conv.get('openingStates') or [initial]

def diff_state(base, over, prefix=''):
    diffs = []
    for k, v in over.items():
        path = f'{prefix}.{k}' if prefix else k
        b = base.get(k) if isinstance(base, dict) else None
        if isinstance(v, dict):
            diffs += diff_state(b or {}, v, path)
        elif b != v:
            diffs.append((path, b, v))
    return diffs

def greeting_block(opening):
    """该开局与 [InitVar] 基底的差值 → <UpdateVariable> _.set 覆盖块（MagVarUpdate 开局机制）"""
    diffs = diff_state(initial, opening)
    if not diffs:
        return ''
    lines = '\n'.join(
        f"_.set('{path}', {js_obj(old)}, {js_obj(new)});//故事开始的设定"
        for path, old, new in diffs)
    return f'\n\n<UpdateVariable>\n{lines}\n</UpdateVariable>'

def clean_greeting(s, opening):
    return MARKER.sub('', s).rstrip() + greeting_block(opening)

# ── 3. tavern_helper 脚本（MagVarUpdate + MVU Zod）───────────────────
magvarupdate_script = {
    'type': 'script', 'enabled': True, 'name': 'MagVarUpdate',
    'id': str(uuid.uuid4()),
    'content': "import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';",
    'info': '',
    'button': {'enabled': True, 'buttons': [
        {'name': name, 'visible': False} for name in
        ['重新处理变量', '重新读取初始变量', '快照楼层', '重演楼层',
         '重试额外模型解析', '清除旧楼层变量', '增量校正额外模型解析']]},
    'data': {}, 'export_with': {'data': True, 'button': True},
}

zod_script = {
    'type': 'script', 'enabled': True, 'name': 'MVU Zod',
    'id': str(uuid.uuid4()),
    'content': f'''import {{ registerMvuSchema }} from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';

export const Schema = z.object({{
  临时变量: z.string().describe('仅在出现美咲、优奈之外的新人物时写入（姓名／身份／一句话定位），该人物退场后删除'),
  全镇常识异化: z.string().describe('小镇居民常识改写的当前状态'),
  环境: z.object({{
    日期: z.string().describe('格式 yyyy-MM-DD HH:mm'),
  }}),
  角色: z.record(
    z.string().describe('角色名'),
    z.object({{
      催眠深度: z.number().int().min(0).max(100).describe('整数0-100，必须与当前阶段同区间：阶段0→0-24；阶段1→25-49；阶段2→50-74；阶段3→75-100'),
      当前位置: z.string().describe('角色所处地点，随移动实时更新；外出时写明镇上具体场所'),
      当前穿着: z.string().describe('角色当下的实际着装，随换装、洗浴、就寝、阶段演变更新'),
      当前设置的额外人设: z.string().describe('★仅由{{{{user}}}}在对话中明确指令时修改，AI绝不擅自更改；留空则按自身人设行动；严禁把动作、行为或短暂情绪写入'),
      当前阶段: z.number().int().min(0).max(3).describe('整数0-3，严格对应「四阶段心智篡夺与玩偶觉醒体系」，不得跳阶段、不得回退'),
      心理防线: z.string().describe('一句话概括该角色此刻的内心状态与防线位置'),
      瞳色: z.string().describe('美咲：清澈浅蓝→紫红；优奈：琥珀棕→紫粉'),
      阶段名称: z.string().describe('与当前阶段同步：0=寻常夏日与客气防线；1=常识微调与正当化借口；2=常识置换与伪家人确立；3=玩偶觉醒与角色扮演'),
    }}),
  ).prefault({js_obj(initial['角色'])}),
}}).prefault({js_obj(initial)});

$(() => {{
  registerMvuSchema(Schema);
}})''',
    'info': '',
    'button': {'enabled': True, 'buttons': []},
    'data': {}, 'export_with': {'data': True, 'button': True},
}

extensions = {
    'talkativeness': '0.5',
    'fav': False,
    'world': BOOK_NAME,
    'depth_prompt': {'prompt': '', 'depth': 4, 'role': 'system'},
    'tavern_helper': {'scripts': [magvarupdate_script, zod_script], 'variables': {}},
    'xiaobaix-tasks': {'tasks': []},
}

creator_notes = src['creator_notes'].replace('[卡片工作台] \n', '')

data = {
    'name': src['name'],
    'description': src['description'],
    'personality': src['personality'],
    'scenario': src['scenario'],
    'first_mes': clean_greeting(src['first_mes'], openings[0]),
    'mes_example': src['mes_example'],
    'creator_notes': creator_notes,
    'system_prompt': src['system_prompt'],
    'post_history_instructions': src['post_history_instructions'],
    'tags': src['tags'],
    'creator': '',
    'character_version': '',
    'alternate_greetings': [clean_greeting(g, o) for g, o in
                            zip(src['alternate_greetings'], openings[1:])],
    'character_book': book,
    'extensions': extensions,
}

# ── 4. 顶层字段（对齐酒馆导出格式）────────────────────────────────────
top = {
    'name': data['name'], 'description': data['description'],
    'personality': data['personality'], 'scenario': data['scenario'],
    'first_mes': data['first_mes'], 'mes_example': data['mes_example'],
    'creatorcomment': creator_notes, 'avatar': 'none',
    'talkativeness': '0.5', 'fav': False, 'tags': data['tags'],
    'spec': 'chara_card_v3', 'spec_version': '3.0', 'data': data,
}

V2_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
             'creator_notes', 'system_prompt', 'post_history_instructions',
             'alternate_greetings', 'character_book', 'tags', 'creator', 'character_version', 'extensions']
v2 = {'spec': 'chara_card_v2', 'spec_version': '2.0',
      'data': {k: data.get(k) for k in V2_FIELDS}}
v3 = top

p_v2 = os.path.join(OUT, f'{STEM}-SillyTavern-v2.json')
p_v3 = os.path.join(OUT, f'{STEM}-SillyTavern-v3.json')
json.dump(v2, open(p_v2, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
json.dump(v3, open(p_v3, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

# ── 5. PNG 卡（占位立绘 + tEXt 块）───────────────────────────────────
W, H = 512, 768
def gradient_png():
    rows = bytearray()
    for y in range(H):
        t = y / (H - 1)
        r = int(28 + 150 * t)
        g = int(24 + 70 * t)
        b = int(46 + 40 * t)
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

png = gradient_png()[:-12]
png += text_chunk('chara', base64.b64encode(json.dumps(v2, ensure_ascii=False).encode('utf-8')).decode('ascii'))
png += text_chunk('ccv3', base64.b64encode(json.dumps(v3, ensure_ascii=False).encode('utf-8')).decode('ascii'))
png += struct.pack('>I', 0) + b'IEND' + struct.pack('>I', binascii.crc32(b'IEND') & 0xffffffff)
p_png = os.path.join(OUT, f'{STEM}-SillyTavern.png')
open(p_png, 'wb').write(png)

# ── 6. 自检 ──────────────────────────────────────────────────────────
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
for tag, target in (('chara', v2), ('ccv3', v3)):
    back = json.loads(base64.b64decode(found[tag]).decode('utf-8'))
    ok = json.dumps(back, sort_keys=True, ensure_ascii=False) == json.dumps(target, sort_keys=True, ensure_ascii=False)
    print(f'  {tag}: spec={back["spec"]} 条目={len(back["data"]["character_book"]["entries"])} 往返一致={ok}')

# DSH 专有 token 不应残留在产物里
blob = json.dumps(v3, ensure_ascii=False)
for tok in ['<initvar>', 'mvu-status', 'mvu_submit', 'dsh_mvu_conversion', 'regex_scripts', '[卡片工作台]']:
    assert tok not in blob, f'残留 DSH 专有 token: {tok}'
print('  DSH 专有 token 检查: 通过')

print()
for p in (p_v2, p_v3, p_png):
    print(f'  {os.path.getsize(p):>8,} B  {os.path.basename(p)}')
print()
print('世界书条目:')
for e in entries:
    print(f'  id={e["id"]:>2} enabled={str(e["enabled"]):5s} constant={str(e["constant"]):5s} '
          f'pos={e["extensions"]["position"]}/d{e["extensions"]["depth"]} order={e["insertion_order"]:<3} '
          f'keys={len(e["keys"]):<2} {e["comment"]}')
print()
print('开场白开局覆盖块:')
for label, g in [('first_mes', data['first_mes'])] + [
        (f'greeting{i+1}', g) for i, g in enumerate(data['alternate_greetings'])]:
    m = re.search(r'<UpdateVariable>[\s\S]*?</UpdateVariable>', g)
    print(f'  {label}: 长度={len(g)} 覆盖块={"有" if m else "无"}')
    if m:
        for line in m.group(0).splitlines():
            if line.startswith('_.set'):
                print('    ', line)
print('initvar YAML 预览:')
print(entries[n + 1]['content'][:300], '...')
