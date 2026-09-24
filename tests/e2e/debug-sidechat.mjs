import assert from 'node:assert/strict'
import { join } from 'node:path'

export async function debugSidechat({ page, step, savedChat, output, report, restartServer }) {
  // Reading diagnostics captures iframe evidence on the source message;
  // that metadata may change, but every gameplay field must remain identical.
  const gameplayMessages = chat => chat.messages.map(({ displayRuntime, ...message }) => message)
  const before = await savedChat()
  const originalUrl = page.url()
  const button = page.getByRole('button', { name: '交给卡片 Agent 调试', exact: true })
  await step('卡片调试在侧边打开，保留当前游戏', async () => {
    await button.click()
    await page.getByText('已关联当前人物卡和游玩记录。', { exact: false }).waitFor()
    assert.equal(page.url(), originalUrl)
    await page.getByText('你获得了十枚金币。', { exact: false }).filter({ visible: true }).first().waitFor()
    const after = await savedChat()
    assert.ok(after.debugSidechatSessionId)
    assert.notEqual(after.debugSidechatSessionId, before.sessionId)
    assert.deepEqual(gameplayMessages(after), gameplayMessages(before))
    report.debugChild = after.debugSidechatSessionId
  })
  await step('侧边卡片 Agent 使用真实诊断工具，结果不进入剧情', async () => {
    const input = page.getByPlaceholder('Ask a follow-up…', { exact: true })
    await input.fill('E2E 卡片侧聊：请读取本局游玩记录并检查问题。')
    await input.press('Enter')
    await page.getByText('调试已读取本局记录。', { exact: true }).waitFor()
    assert.deepEqual(gameplayMessages(await savedChat()), gameplayMessages(before))
    await page.screenshot({ path: join(output, 'debug-sidechat.png'), fullPage: true })
  })
  await step('刷新并重启后继续同一侧聊，不重复创建调试会话', async () => {
    await restartServer()
    // Return to status, then reopen through the original debug entry.
    await page.getByText('酒馆状态', { exact: true }).filter({ visible: true }).first().click()
    await button.click()
    assert.equal((await savedChat()).debugSidechatSessionId, report.debugChild)
    const input = page.getByPlaceholder('Ask a follow-up…', { exact: true })
    await input.fill('E2E 卡片侧聊：继续核对。')
    await input.press('Enter')
    await page.getByText('调试已读取本局记录。', { exact: true }).nth(1).waitFor()
    assert.deepEqual(gameplayMessages(await savedChat()), gameplayMessages(before))
    await page.screenshot({ path: join(output, 'debug-sidechat-restored.png'), fullPage: true })
  })
  await step('关闭后重开仍使用同一调试会话，窄屏可以输入', async () => {
    const title = 'E2E 卡片侧聊：请读取本局游玩记录并检查问题。'
    await page.locator('div[draggable="true"]').filter({ has: page.locator('span', { hasText: title }) }).getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByText('酒馆状态', { exact: true }).filter({ visible: true }).first().click()
    await button.click()
    await page.getByText('调试已读取本局记录。', { exact: true }).nth(1).waitFor()
    assert.equal((await savedChat()).debugSidechatSessionId, report.debugChild)
    await page.setViewportSize({ width: 700, height: 900 })
    await page.getByPlaceholder('Ask a follow-up…', { exact: true }).waitFor()
    await page.screenshot({ path: join(output, 'debug-sidechat-narrow.png'), fullPage: true })
  })

}
