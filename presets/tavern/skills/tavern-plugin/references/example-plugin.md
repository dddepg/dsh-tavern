# 示例插件

源码与仓库 `examples/tavern-plugin-hello/index.mjs` 相同。

```js
// 最小 Tavern 插件示例：每轮正文写完后，在第一句话所在的段落后面挂一张图。
// 把 drawImage() 换成你自己的生图服务，就是一个完整的生图插件。
// 接口说明见 docs/plugin-api.md。

export const name = 'tavern-plugin-hello'
export const inject = ['tavern', 'attachments']

// 一张 96×64 的蓝色 PNG，代替真正的生图结果。
const DEMO_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAAaUlEQVR42u3QMQ0AAAgDsMlBIhKRhQNujiZV0FQPhygQJEiQIEGCBAlCkCBBggQJEiQIQYIECRIkSJAgBAkSJEiQIEGCBCFIkCBBggQJEoQgQYIECRIkSBCCBAkSJEiQIEGCECRIkKB/FrvQwfDSKcbsAAAAAElFTkSuQmCC'

async function drawImage(_prompt) {
  return { data: new Uint8Array(Buffer.from(DEMO_PNG, 'base64')), mediaType: 'image/png' }
}

export function apply(ctx) {
  if (ctx.tavern.apiVersion < 1) return
  ctx.tavern.onTurnSettled(async turn => {
    const firstSentence = turn.text.split(/(?<=[。！？!?])/)[0].trim()
    // 先挂一个占位，正文里马上显示「生成中…」。
    const { id } = await ctx.tavern.attach({
      gameId: turn.gameId, turn: turn.turn, textVersion: turn.textVersion,
      item: { kind: 'image', status: 'pending', anchor: firstSentence, caption: '示例插图' }
    })
    try {
      const image = await drawImage(turn.text)
      const attachment = await ctx.attachments.saveImage({ data: image.data, mediaType: image.mediaType, name: 'hello' })
      await ctx.tavern.update(id, { status: 'ready', attachment })
    } catch (error) {
      await ctx.tavern.update(id, { status: 'failed', error: String(error?.message || error).slice(0, 200) })
    }
  })
}
```
