# dsh-all-notify

DeepSeek Harness 的原生系统通知插件：审批、提问、任务结束、出错时弹出 **Windows 系统 toast**，
并为「页面正在看的那个会话」静音。

零运行时依赖，无构建步骤。

中文 | [English](README.en.md)

## 特性

- **原生系统通知**，不是浏览器 `Notification` API。宿主进程直接调用 PowerShell + WinRT
  `ToastNotificationManager`，浏览器关掉也照弹。
- **带会话名称**。每条通知都带上会话标题，从持久化的 `title` 投影按需读取。
- **只在需要时打扰**。事件属于页面上正在看的会话、且页面在前台时不弹；切到别的软件后，
  同一个会话的事件会重新提醒。
- **零运行时依赖**。没有 `node-notifier`，没有需要下载的二进制，没有解析失败的可能。
- 每种结局都有独立开关。

## 安装

```powershell
dsh plugin --profile web add github:mkasoy/dsh-all-notify

```

改了宿主半身需要重启 `dsh web`；只改浏览器半身刷新页面即可。

## 通知内容

| 事件 | 通知 |
|---|---|
| `approval/request` | `需要你的批准` — 工具名与原因。**沙箱提权审批也走这里。** |
| `user-questions/request` | `需要你的回答` — 第一个问题 |
| `session/event` + `turn/end` | `任务完成` / `任务出错` / `任务已中止` / `任务被阻塞` / `任务达到输出上限` |
| `agent/error` | `出错` — 错误码与信息 |

每条通知第二行的格式是 `「会话标题」 · 事件细节`。

**一次失败的轮次只弹一条。** `agent/error` 先上报，随后同一轮次的 `turn/end(error)`
会被识别为已上报，不再重复。

## 静音规则

只有同时满足两个条件才静音：

1. 事件所属会话 = 页面上正在显示的会话，**且**
2. 页面在前台

也就是说，你切到别的软件之后，即使页面还停在那个会话上，它的事件**会**重新提醒。
其余情况一律通知。

浏览器半身每 10 秒上报一次「当前会话 + 页面可见性」，切换会话和
`visibilitychange` 时也会立即上报；上报超过 30 秒视为失效，通知恢复。

## 配置

所有键都可选。写在插件自己的 `cordis.patch.yml`，或在
`~/.dsh/profiles/web/cordis.patch.yml` 里用同一个行 id 覆盖：

```yaml
- id: all-notify
  config:
    enabled: true                # 总开关
    onApproval: true             # 审批请求
    onQuestion: true             # 提问
    onCompleted: true            # 正常结束
    onError: true                # 轮次或步骤失败
    onAborted: true              # 被中止
    onBlocked: true              # 被阻塞
    onMaxTokens: true            # 达到输出上限
    appName: DeepSeek Harness    # 通知上显示的应用程序名
    debug: false                 # true 时把每次决策打到 dsh web 终端
```

## 工作原理

```
┌──────────── 浏览器 (lib/client.js) ────────────┐
│  inject: []            ← 不可能停在 PENDING    │
│  apply 整体 try/catch  ← 不可能让 boot 失败    │
│                                                │
│  当前会话 id + document.hidden                 │
│         │ POST /dsh-all-notify/state           │
└─────────┼──────────────────────────────────────┘
          ▼
┌──────────── 宿主 (lib/index.js) ───────────────┐
│  inject: []                                    │
│  viewer = { sessionId, hidden, at }            │
│                                                │
│  approval/request ─┐                           │
│  user-questions/request ─┤                     │
│  session/event(turn/end) ─┼→ 静音? → spawn     │
│  agent/error ─┘                powershell      │
│                                   → WinRT toast│
└────────────────────────────────────────────────┘
```

宿主半身**只监听事件**，浏览器半身**只上报观察状态**，两者通过一条自定义 HTTP 路由通信。
不用 Remote 命名空间——对这个体量的需求是不必要的复杂度，而且 Typert 属于预稳定协议。

**浏览器半身是顾问角色，不是必需件。** 它不工作时宿主收不到上报，于是**所有事件都通知**——
失败方向是多弹，不是哑掉。

## 设计约束

每一条都对应一个在 DSH 0.1.7-alpha.1 上实测到的第三方插件故障：

- **宿主 `inject` 为空。** `inject` 里列了没有提供方的服务，会让纤程永远停在 PENDING，
  且**不报错**。
- **每个监听器整体 `try/catch`。** 逸出的异常会让条目激活失败，客户端启动审计报
  `web boot: 1 entry did not activate`。
- **两个瀑布监听器都 `return next()`。** 返回其它值会被当作「认领决策」，
  GUI 里再也弹不出授权卡片。
- **不用 `ctx.settings.register`。** DSH 0.1.7 把插件注册的设置命名空间换成了由 Loader
  条目派生的配置表单，这个 API 已不存在。
- **浏览器半身 `inject` 为空且整体包 `try/catch`。** 读不到任何东西时只会退化成
  「不静音」，不会拖垮启动。
- **零运行时依赖。**

## 实测记录：Windows 上的两个坑

这两个都是 A/B 隔离出来的，**不是推测**，也不违反直觉地容易被当成多余写法「优化」掉，
所以写进文档。

### 1. `detached` 的子进程弹不出通知

| 变体 | 结果 |
|---|---|
| `detached: true` + `unref()` + `-EncodedCommand` | ❌ 不弹 |
| 前台 `-EncodedCommand` | ✅ |
| `-File` 脚本 | ✅ |
| 内联 ASCII `-Command` | ✅ |

detached 子进程在 Windows 上会拿到自己的控制台，这样起来的 PowerShell `Show()` 不报错、
通知历史里也查得到，**但屏幕上什么都不弹**。编码不是问题——同一个 `-EncodedCommand`
payload 只要不 detached 就正常。

### 2. `ToastGeneric` 模板不显示，`ToastText02` 才显示

| 模板 | 结果 |
|---|---|
| `ToastText02`（旧） | ✅ 弹 |
| `ToastGeneric`（新） | ❌ 不弹 |

同样是「进了通知历史但不弹」。两个模板都由系统外壳按当前浅色/深色渲染，
`ToastNotification` 也没有 per-toast 主题属性，所以用旧模板不损失任何东西。

## 兼容性

开发与实测于 **DSH 0.1.7-alpha.1**（`dsh web` profile，Windows 11 + Windows PowerShell 5.1）。

宿主半身只依赖以下接口，它们在 0.1.7-alpha.1 中均已验证存在：

| 接口 | 位置 |
|---|---|
| `approval/request` 瀑布 | `packages/interaction/user-approval` |
| `user-questions/request` 瀑布 | `packages/interaction/user-questions` |
| `session/event` + `turn/end` | `packages/core/session` |
| `agent/error` | `packages/core/agent-loop` |
| `title` 投影 | `@deepseek-ai/dsh-session-title` |
| `webServer.register` | `@deepseek-ai/dsh-host-webserver` |
| `sessions.list` / `sessions.retainInfo`（浏览器侧） | `@deepseek-ai/dsh-api-session-controller` |

浏览器半身判定「当前会话」用的是引用计数
`sessions.retainInfo(id).retainedBy.mainView > 0`，这是 0.1.7-alpha.1 里表示
「该会话正显示在主对话中」的信号。

## 已知限制

- **仅 Windows。** 其它平台宿主半身会加载但不做任何事。
- **约 1 秒延迟。** 每次通知都要起一个 PowerShell 进程（0.5–1 秒）。换成
  `node-notifier`（自带 SnoreToast）可压到几十毫秒，代价是引入依赖树——本插件刻意不要依赖。
- **多标签页会互相覆盖。** 每个标签页按自己的心跳上报，谁后报谁算「当前会话」。
  单标签页使用不受影响。
- **上报内容按原样信任。** 路由只能在服务器同源访问。
- 配置写在 `cordis.patch.yml`，没有图形设置页——那需要引入浏览器半身的依赖面，
  正是本插件要避开的失败来源。

## 开发

没有构建步骤，源码即产物。

```powershell
node --check lib\index.js
node --check lib\client.js
```

宿主半身可以离线驱动：构造一个假的 `ctx`（`inject` / `effect` / `on` / `get` / `logger`），
执行 `apply(ctx, { debug: true, enabled: false })`，然后手动触发捕获到的监听器。
`enabled: false` 会让 `notify` 停在日志阶段，从而在不真弹通知的前提下断言决策。

## License

MIT
