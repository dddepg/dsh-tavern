import { defineTool } from '@deepseek-ai/dsh-tools'

export function registerCardEditingTools({
  activeTurnOf,
  restoreCurrentCard,
  str,
  tools,
  turnOrchestrator,
}) {
  tools.register(defineTool({
    name: 'tavern_update_card',
    description: '仅当用户明确要求或确认修改时，立即保存最小的人物卡变更；保存后调用 tavern_validate_card 检查实际文件。path 可指定任意人物卡，省略时改当前打开的卡；无需事先挂载或引用。空白工作台会直接创建并绑定正式人物卡文件，必须同时具备角色名和玩家身份。另存为副本时先调用 tavern_copy_card，由工具保留源卡 PNG。只讨论时不要调用。',
    parameters: {
      path: { type: 'string', description: '可选的人物卡路径，如 cards/角色 v2.json；省略时修改当前打开的人物卡' },
      fields: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          personality: { type: 'string' },
          scenario: { type: 'string' },
          first_mes: { type: 'string' },
          mes_example: { type: 'string' },
          system_prompt: { type: 'string' },
          post_history_instructions: { type: 'string' },
          creator_notes: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          alternate_greetings: { type: 'array', items: { type: 'string' } },
          player: { type: 'string', description: '新建人物卡时用于约束 {{user}} 视角的玩家身份' }
        }
      },
      rawOperations: {
        type: 'array',
        description: '仅用于标准字段和专用资源工具无法覆盖的扩展字段；不能修改世界书。按 JSON Pointer 对完整工作 raw 做最小 set/delete 修改',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            op: { type: 'string', required: true, enum: ['set', 'delete'] },
            path: { type: 'string', required: true, description: 'JSON Pointer，例如 /data/extensions/regex_scripts/0/disabled' },
            value: { type: 'json', description: 'set 操作的新值；delete 时省略' }
          }
        }
      }
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          saved: { type: 'boolean', required: true },
          path: { type: 'string' },
          mode: { type: 'string', required: true, enum: ['card'] },
          changed: { type: 'boolean', required: true },
          createsCard: { type: 'boolean', required: true },
          changedFields: { type: 'array', required: true, items: { type: 'string' } }
        }
      },
      render: function (_args, value) {
        const detail = value.changedFields.length > 0 ? '：' + value.changedFields.join('、') : ''
        if (value.createsCard) return [{ type: 'text', text: '已创建并绑定正式人物卡' + detail }]
        const where = value.path ? '（' + value.path + '）' : ''
        if (!value.changed) return [{ type: 'text', text: '提交内容与当前设定相同，无需改动' + where }]
        return [{ type: 'text', text: '已保存人物卡变更' + where + detail }]
      }
    },
    async execute(args, exec) {
      const sessionId = exec && exec.agent && exec.agent.session ? exec.agent.session.id : ''
      return await turnOrchestrator.saveChanges({
        sessionId,
        turn: activeTurnOf(exec),
        path: args.path,
        fields: args.fields,
        rawOperations: args.rawOperations
      })
    }
  }))

  tools.register(defineTool({
    name: 'tavern_restore_card',
    description: '灾难恢复工具：仅当用户明确要求将当前正式人物卡从 originals 原版整体恢复、已获知会覆盖全部工作版修改，并再次明确确认后使用。普通编辑、撤销、不确定或空白工作台严禁调用。恢复前会自动备份当前工作版。',
    parameters: {
      confirmation: {
        type: 'string',
        required: true,
        enum: ['确认从原版恢复'],
        description: '只能在用户已经明确确认整体覆盖后填写固定文本“确认从原版恢复”；不得由 Agent 代替用户确认'
      }
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          name: { type: 'string', required: true },
          originalPath: { type: 'string', required: true },
          backupPath: { type: 'string', required: true }
        }
      },
      render: function (_args, value) {
        return [{ type: 'text', text: '人物卡《' + value.name + '》已从原版恢复并立即生效。恢复前工作版已备份到 ' + value.backupPath }]
      }
    },
    async execute(args, exec) {
      if (str(args && args.confirmation) !== '确认从原版恢复') throw new Error('原版恢复缺少明确确认')
      const sessionId = exec && exec.agent && exec.agent.session ? exec.agent.session.id : ''
      const turn = activeTurnOf(exec)
      if (turn > 0) await turnOrchestrator.discard({ sessionId: sessionId, turn: turn })
      return await restoreCurrentCard(sessionId)
    }
  }))
}
