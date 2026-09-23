// Keep the conversion contract separate from generic card editing. JSON values
// carry story-specific state; the tool owns all executable/template scaffolding.
export function registerMvuConversionTools({ tools, defineTool, conversion, chatForSession }) {
  const output = {
    schema: { type: 'object', additionalProperties: false, properties: { report: { type: 'json', required: true } } },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.report, null, 2) }]
  }
  const failure = error => {
    if (!error.code || !error.details) throw error
    return {report:{ok:false,error:{code:error.code,message:error.message,...error.details}}}
  }
  const requireWorkbench = async exec => {
    const chat = await chatForSession(exec?.agent?.session?.id || '')
    if (chat?.mode !== 'card') throw Error('MVU 转换工具只能在卡片工作台使用')
  }
  tools.register(defineTool({
    name: 'tavern_convert_to_mvu',
    description: '将人物卡转换为独立 MVU 副本。先 inspect 获取原文、版本和 stateInventory，完整提取后 saveDefinition 持久化字段结构及各开场已有值，再以 definitionRevision 装配，仅缺失长字段用 read.paths 批量补读。apply 已内置预检、原子保存和磁盘验收；仅有定位疑问时额外 preview。已有副本默认合并已保存方案，省略的定义与清理保留。工具从磁盘复制整卡后清理并追加 MVU；参数仅提交改动和变量定义，不回传原卡或保留内容。工具根据保存的字段定义直接生成初值/后台规则、固化原美化、每个开场入口、模型历史隔离与绑定，有原美化时必须指定 appearance，先 freezeAppearance 核验；工具直接复制来源 HTML/CSS，只绑定变量，不接受模型重写外观。无原美化优先用 tavern_design_mvu_appearance，设计失败再用默认模板。标准转换只需目标卡和 Skill 配方，不需要查其他卡或工具源码。同一来源和名称可重复调用；更新现有副本须提供 inspect 返回的 targetRevision。',
    parameters: {
      action: { type: 'string', required: true, enum: ['inspect', 'read', 'search', 'freezeAppearance', 'saveDefinition', 'preview', 'apply'] },
      sourcePath: { type: 'string', required: true, description: '原卡 cards/... 路径；始终保留原卡' },
      detail: { type: 'string', enum: ['reading','summary','full'], description: 'inspect 默认 reading 一次返回有预算的原文；summary 仅目录，full 为完整原卡及副本' },
      scope: { type: 'string', enum: ['source','target','plan','definition','preservedWorldbook'], description: 'read/search 默认 source；definition 需 definitionRevision；target/plan 还需 targetRevision，路径均相对于该对象' },
      path: { type: 'string', description: 'read/search 的 JSON Pointer；空串为根目录，read 对象返回子目录，字符串分页返回 text' },
      paths: { type:'array', items:{type:'string'}, description:'read 可批量读取 1–20 个字段，省去逐项往返；总原文预算 12000 字符' },
      query: { type: 'string', description: 'search 必填：原文片段，非正则，最多 1000 字符' },
      offset: { type: 'number', description: 'read 的字符/目录起点，search 的匹配结果起点；使用返回的 nextOffset 续读' },
      limit: { type: 'number', description: '每页上限：字符串 8000 字符、目录 100 项、搜索 40 项' },
      planMode: { type: 'string', enum: ['merge','replace'], description: 'apply/preview 默认 merge：保留已保存定义和清理，追加去重；replace 显式替换完整方案，需要重新提交全部定义和清理' },
      cleanupResetPaths: { type: 'array', items: { type: 'string' }, description: 'merge 时先移除这些原卡路径的全部旧清理操作，再追加 cleanup；纠正同字段操作时使用' },
      name: { type: 'string', description: '副本名称，默认原卡名加 MVU版本；重复调用保持相同名称' },
      sourceRevision: { type: 'string', description: 'read/search/saveDefinition/preview/apply 必填，inspect 返回的来源版本' },
      targetRevision: { type: 'string', description: '更新副本时填 inspect 返回的目标版本' },
      definitionRevision: {type:'string',description:'saveDefinition 返回的持久化定义版本。apply/preview 直接读取该定义，不重新提交初值、规则和展示配置。'},
      openingStates: {type:'json',description:'saveDefinition 可选：按开场顺序排列的完整初值对象；省略则复制 initialState 为每个开场底稿，再由工具按来源映射写入各自已有值。未知值须明确为空。'},
      sourceFields: {type:'array',description:'saveDefinition 补充自动清单未识别的字段：使用 read/search 的原文字符范围；值由工具直接复制。',items:{type:'object',additionalProperties:false,properties:{
        path:{type:'string',required:true},offset:{type:'number',required:true},length:{type:'number',required:true},label:{type:'string'}
      }}},
      fieldMappings: {type:'array',description:'saveDefinition 为 stateInventory 每项提供唯一目标路径；含所有人物和开场。补充 sourceFields 可先 inspect 同参数取得 ID。',items:{type:'object',additionalProperties:false,properties:{
        sourceId:{type:'string',required:true},path:{type:'string',required:true}
      }}},
      initialState: { type: 'json', description: 'saveDefinition 必填：变量初值对象，不包裹 stat_data；可扩展集合保留 $meta' },
      updateRules: { type: 'string', description: 'saveDefinition 必填：路径、类型及依据剧情事实更新的规则' },
      displayFields: { type: 'array', description: '可选展示字段；首次省略则展示全部非内部字段，增量省略沿用已保存配置', items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true, description: '相对于初值的 JSON Pointer，如 /玩家/位置；可选择整个集合' },
        label: { type: 'string', description: '显示名称' }
      } } },
      appearance: { type: 'object', additionalProperties: false, description: '从原卡固化外观；只传来源和捕获字段映射，不传 HTML。已有方案省略则保留。', properties: {
        sourcePath: { type:'string', required:true, description:'inspect.appearanceSources 返回的 replaceString 路径' },
        collectionPath: {type:'string',description:'多人面板集合路径，如 /人物；所有 bindings.path 相对于成员（如 /姓名），不能混入顶层 /时间。省略时所有路径相对于整个初值。'},
        bindings: { type:'array', required:true, items:{type:'object',additionalProperties:false,properties:{
          capture:{type:'number',required:true,description:'原视图 $1/$2 的捕获编号'},
          path:{type:'string',required:true,description:'MVU 初值的 JSON Pointer'}
        }}}
      } },
      cleanup: { type: 'array', description: '相对于 source 底稿的小改动；版本号校验整个底稿。整项删除只传路径，短改文只传片段，长区块只传首尾标记；同字段支持多处不重叠编辑。无需回传原卡。', items: { type: 'object', additionalProperties: false, properties: {
        op: { type: 'string', required: true, enum: ['replaceText', 'replaceBlock', 'replace', 'remove'] },
        path: { type: 'string', required: true, description: '如 /description 或 /character_book/entries/0；数组下标按 inspect 底稿' },
        reason: { type: 'string', description: '简短说明本项为何属于旧状态/候选项实现；保留到验收删除清单' },
        expected: { type: 'json', description: '仅 replaceText 必填：恰好出现一次的短原文；remove/replace 省略，无需回传完整原值' },
        start: { type: 'string', description: 'replaceBlock 必填：在字段内唯一的起始标记，包含在替换范围中' },
        end: { type: 'string', description: 'replaceBlock 必填：在字段内唯一且位于 start 后的结束标记，同样包含在替换范围中' },
        value: { type: 'json', description: '替换值；replaceText/replaceBlock 必须是字符串，删除片段或区块用空字符串；replace 仅提交新值，remove 省略' }
      } } }
    },
    output, isConcurrencySafe: () => false,
    async execute(args, exec) {
      await requireWorkbench(exec)
      try {
        if (['apply','preview'].includes(args.action) && !args.definitionRevision && ['initialState','openingStates','updateRules','displayFields','appearance'].some(key=>Object.hasOwn(args,key))) throw Error('先 saveDefinition 保存字段结构，再以 definitionRevision 装配；apply 不接收重新转录的定义')
        return { report: await conversion.convert(args) }
      }
      catch (error) {
        return failure(error)
      }
    }
  }))
  tools.register(defineTool({
    name: 'tavern_design_mvu_appearance',
    description: '原卡没有美化时，为完整 MVU 定义设计人物卡风格的 HTML/CSS 面板并持久化。html 使用 $1/$2 文本占位，bindings 映射字段；多人指定 collectionPath 并使用相对成员路径。工具校验全部定义字段的展示覆盖，注入统一更新/新增/回退逻辑，返回 definitionRevision 供转换 apply 直接使用。有原美化时拒绝覆盖；不接受自定义 JavaScript、事件属性或嵌入文档。失败可修改设计重试，或用 saveDefinition 保存默认面板并报告原因。',
    parameters: {
      sourcePath:{type:'string',required:true},sourceRevision:{type:'string',required:true},
      initialState:{type:'json',required:true},openingStates:{type:'json'},updateRules:{type:'string',required:true},
      html:{type:'string',required:true,description:'与人物卡风格相符的 HTML/CSS，动态值仅放在文本节点的 $1、$2 等占位中；使用原生 details 折叠。HTML 不支持 {{user}}/{{char}}、EJS、动态属性；标签写“玩家”等静态文字。'},
      collectionPath:{type:'string',description:'指定后全部 bindings 相对于每个成员，不支持混入集合外全局字段。需要同时显示全局字段时省略本参数，使用完整根路径；不要删除字段来适应模式。'},
      bindings:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{capture:{type:'number',required:true},path:{type:'string',required:true}}}},
      sourceFields:{type:'array',items:{type:'object',additionalProperties:false,properties:{path:{type:'string',required:true},offset:{type:'number',required:true},length:{type:'number',required:true},label:{type:'string'}}}},
      fieldMappings:{type:'array',items:{type:'object',additionalProperties:false,properties:{sourceId:{type:'string',required:true},path:{type:'string',required:true}}}}
    },
    output,isConcurrencySafe:()=>false,
    async execute(args,exec) {
      await requireWorkbench(exec)
      const {html,bindings,collectionPath,...definition}=args
      try { return {report:await conversion.convert({...definition,action:'saveDefinition',appearance:{html,bindings,...(collectionPath?{collectionPath}:{})}})} }
      catch (error) { return failure(error) }
    }
  }))
  tools.register(defineTool({
    name: 'tavern_validate_mvu_conversion',
    description: '只读验收专用工具生成的 MVU 副本：报告实际删除/保留条目、已识别旧渲染残留与方案外修改，从磁盘检查绑定、初值、后台分流、所有开场、面板唯一性与模型历史隔离，并在隔离 DOM 中模拟托管视图的变量更新/恢复。不会调用模型或执行原卡自定义脚本；报告明确列出未实测的真实结算和浏览器项目。',
    parameters: { path: { type: 'string', required: true, description: '转换后的 cards/... 副本路径' } },
    output, isConcurrencySafe: () => true,
    async execute(args, exec) { await requireWorkbench(exec); return { report: await conversion.verify(args) } }
  }))
}
