# Windows 适配记录

目标环境：Windows x64，DSH Desktop 2.0.17，客户端包 0.2.0-rc.2，Node 24.19.0。

## 已修改

- 从 PATH 中的 dsh.cmd 读取 Desktop 安装路径（不执行 launcher），支持 D 盘及含空格目录。
- 添加 DSH Desktop/resources/app 常见路径；显式 --dir 错误时不回退修改另一份安装。
- 支持 react.memo 包装的 UserMessageNodeView，保留 renderMessageImages/openFile/openSkill 参数。
- 当前版本没有 useAccess，采用已注入的撤回函数判断按钮是否可用，实际请求仍由 Host 判定权限。
- 当前版本以 setDraft + bindDraftMirror 保存草稿；persistDraft 仅在接口存在时调用。
- 同一按钮使用 ref 防止快速重复点击；草稿接口缺失时先报错，不执行撤回。
- 补丁写入前进行 JS 语法验证；备份冲突时停止，避免覆盖旧备份。
- 修复 --dry-run 隐式还原问题，包括 --restore --dry-run 也只读。
- 测试动态 import 使用 file URL，兼容 Windows 盘符。

## 验证

```powershell
$env:DSH_ROOT = 'D:\DSH Desktop\resources\app'
node scripts\patch-native.cjs --dry-run
node scripts\test.mjs
node scripts\test-windows.cjs
```

以上均已通过。Windows 测试只在临时副本上实际打补丁，覆盖含空格路径、安装、重复执行、只读预检、还原；另测撤回处理函数、草稿接口和重放过滤。Host 集成测试使用实际 Session 类与模拟 agent，核对保留前缀、日志完整、上下文隐藏、重复撤回及后续新消息。

## 当前状态

仅修改本仓库；尚未安装 Host 插件，尚未修改实际 Desktop bundle，尚未执行真实 GUI 点击与刷新后草稿恢复测试。静态接口兼容及临时副本测试通过不等于 GUI 端到端验收完成。

正式安装时先安装本目录 bundle，再完全退出 Desktop 后执行补丁并重启。客户端升级后不要盲目以旧备份覆盖新安装；应保留旧备份另存并重新预检。
