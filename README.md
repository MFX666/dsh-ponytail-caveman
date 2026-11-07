# session-prompts

一个 DSH（DeepSeek Harness）Host 插件：在**每个会话开始时向系统提示词注入工作风格提示**，相当于其他 Agent 工具里的 SessionStart hook。

灵感来源（均为在 session 启动时注入提示词的插件）：

- [ponytail](https://github.com/DietrichGebert/ponytail) —— "懒惰高级开发"（lazy senior dev）：用最少的代码解决整个问题，优先复用。
- [pi-caveman](https://github.com/jonjonrankin/pi-caveman) —— "穴居人模式"（caveman）：极简输出，砍掉废话但保留全部技术实质，输出 token 约省 75%。

## 工作原理

插件通过 `ctx.systemPrompt.section()` 注册两个全局提示词 section：

- `session-prompts:ponytail`（排序 450，位于 persona 之后、plan policy 之前）
- `session-prompts:caveman`（排序 460）

系统提示词在**每一次模型请求前**重新组装，全局 section 对当前进程内所有 Agent（根会话与子 Agent）生效——修改配置后立即对新会话和已有会话生效，无需重启。

## 配置

推荐方式：在**用户层** `$DSH_PROFILE_DIR/cordis.patch.yml` 中加一条覆盖行（优先级高于 bundle 层，改完即时生效，升级不丢）：

```yaml
- id: session-prompts
  config:
    ponytail: full   # off | lite | full | ultra
    caveman: off     # off | lite | full | ultra
```

或者直接修改本目录的 `cordis.patch.yml` 后重新安装（remove_bundle + install_bundle）使 bundle 层配置重新加载：

```yaml
- id: session-prompts
  name: '@local/session-prompts'
  config:
    ponytail: full   # off | lite | full | ultra
    caveman: off     # off | lite | full | ultra
```

### ponytail 等级（懒高级开发）

| 等级 | 内容 |
|---|---|
| `off` | 关闭 |
| `lite` | 核心阶梯：能用现成的就不写新的；做完要说清跳过了什么 |
| `full` | 阶梯 + 先读作用域 + 最小完整改动 + 注释/自测/根因修复规则 |
| `ultra` | full + 写之前先扫现有代码、等大时选边界更正确的方案、明确拒绝投机性泛化 |

### caveman 等级（极简输出）

| 等级 | 内容 |
|---|---|
| `off` | 关闭 |
| `lite` | 保留完整句子，去掉废话和客套 |
| `full` | 允许短句、去冠词，`[ thing] [action] [reason]` 模式 |
| `ultra` | full + `->` 表示因果、激进缩写、一条一个想法 |

caveman 所有等级都带 **safety override**：安全警告、不可逆/破坏性操作、需要原样复制的报错、用户困惑时自动恢复自然语言。

## 安装

在 DSH 会话中：

```
plugin_manager install_bundle target=<本目录绝对路径>
```

## 文件结构

```
package.json       bundle 清单（dsh.bundle.patch 指向 cordis.patch.yml）
cordis.patch.yml   插入 session-prompts 行及默认配置
index.js           Host 插件：Config schema + section 注册
locale/en.json     英文标题/描述（Plugin Manager 显示）
locale/zh.json     中文标题/描述
icon.svg           原创图标（双气泡：代码风格 + 极简输出）
```
