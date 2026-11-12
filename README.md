# dsh-ponytail-caveman

一个 DSH（DeepSeek Harness）Host 插件：在**每个会话开始时向系统提示词注入工作风格提示**，相当于其他 Agent 工具里的 SessionStart hook。

灵感来源（均为在 session 启动时注入提示词的插件）：

- [ponytail](https://github.com/DietrichGebert/ponytail) —— "懒惰高级开发"（lazy senior dev）：用最少的代码解决整个问题，优先复用。
- [pi-caveman](https://github.com/jonjonrankin/pi-caveman) —— "穴居人模式"（caveman）：极简输出，砍掉废话但保留全部技术实质，输出 token 约省 75%。

## 工作原理

插件通过 `ctx.systemPrompt.section()` 注册 `dsh-ponytail-caveman:style`（排序 450，位于 persona 之后、plan policy 之前），每次模型请求前重新组装——所有 Agent（根会话与子 Agent）生效，且即使长会话 compaction 折叠了早期消息，风格规则依然生效。

早期版本还曾在 `agent/created` 时向会话轨迹注入一条可见 user/message，但该消息在 orca-worktree 等 worker 会话流程中可能先于受保护的 system head 被持久化，污染 v4 会话日志（下次打开报 "requires a protected first surface head"）。该层已移除：section 在每次请求中生效且不写 surface 记录，功能上完全覆盖它。

## 配置

**推荐方式：插件详情页。** 打开 DSH 设置 →「内置插件」→「会话提示词注入」详情页，源文档下方即配置面板：

- 两个模式下拉：`off | lite | full | ultra`
- 两个可选自定义规则文本框：留空用所选等级的内置文本，填写则覆盖内置文本
- 保存后写入用户层配置（`$DSH_PROFILE_DIR/cordis.patch.yml` 的覆盖行），插件自动重启，对新会话与已有会话即时生效

等效的配置文件方式——在用户层 `cordis.patch.yml` 加覆盖行（优先级高于 bundle 层，改完即时生效，升级不丢）：

```yaml
- id: dsh-ponytail-caveman
  config:
    ponytail: full      # off | lite | full | ultra
    caveman: full       # off | lite | full | ultra
    ponytailText: ""    # 可选，自定义 ponytail 规则文本
    cavemanText: ""     # 可选，自定义 caveman 规则文本
```

或者直接修改本目录的 `cordis.patch.yml` 后重新安装（remove_bundle + install_bundle）使 bundle 层配置重新加载：

```yaml
- id: dsh-ponytail-caveman
  name: '@local/dsh-ponytail-caveman'
  config:
    ponytail: full   # off | lite | full | ultra
    caveman: full    # off | lite | full | ultra
```

### ponytail 等级（懒高级开发）

内置文本逐字取自上游 [ponytail SKILL.md](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md)：

| 等级 | 内容 |
|---|---|
| `off` | 关闭 |
| `lite` | 按要求构建，用一行点名更小的选项让用户选 |
| `full` | 上游完整规则：先读作用域、最小完整改动阶梯、注释/自测/根因修复、"Never cut" 清单 |
| `ultra` | full + 质疑请求本身：需求撑不住的部分先反驳再动手 |

### caveman 等级（极简输出）

内置文本逐字取自上游 [pi-caveman caveman.ts](https://github.com/jonjonrankin/pi-caveman/blob/main/extensions/caveman.ts)（BASE + INTENSITY + SAFETY，按上游同等级拼装）：

| 等级 | 内容 |
|---|---|
| `off` | 关闭 |
| `lite` | 保留冠词和完整句子，去废话去客套，紧凑高级工程师风格 |
| `full` | 上游 BASE：去冠词、短句 OK，`[thing] [action] [reason]` 模式，正反示例 |
| `ultra` | full + 缩写（DB/auth/config…）、去连词、`→` 表因果 |

caveman 所有等级都带上游 **SAFETY**：安全警告、不可逆操作确认、用户困惑时自动恢复自然语言；"stop caveman" / "normal mode" 恢复。

## 安装

在 DSH 会话中：

```
plugin_manager install_bundle target=<本目录绝对路径>
```

## 文件结构

```
package.json       bundle 清单（dsh.bundle.patch + dsh.client 声明）
cordis.patch.yml   插入 dsh-ponytail-caveman 行及默认配置
index.js           Host 插件：Config schema + section 注册 + 配置路由
client.js          插件详情页配置面板（plugins.bundle.config，同 voice-input 范式）
locale/en.json     英文标题/描述（Plugin Manager 显示）
locale/zh.json     中文标题/描述
icon.svg           原创图标（双气泡：代码风格 + 极简输出）
```
