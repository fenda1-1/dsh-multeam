<div align="center">

<a href="https://github.com/fenda1-1/dsh-multeam">
  <img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=700&size=32&duration=2800&pause=1200&color=7AA2F7&center=true&vCenter=true&width=500&height=60&lines=%40fenda1-1%2Fmulteam;Multi-Agent+Teams+for+DSH" alt="multeam" />
</a>

<p>
  <strong>DeepSeek Harness 的多智能体团队插件</strong><br/>
  名册 · 持久邮箱 · 共享任务 DAG · 作用域工具 · 就绪调度器 · Web 面板
</p>

<p>
  <a href="https://github.com/fenda1-1/dsh-multeam/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-7AA2F7?style=flat-square" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/platform-DeepSeek%20Harness-9ECE6A?style=flat-square" alt="DSH" />
  <img src="https://img.shields.io/badge/tests-185%20passing-brightgreen?style=flat-square" alt="tests" />
</p>

</div>

---

## 这是什么

一个 Lead + N 个 teammate 的协作框架。Lead 把目标拆成任务、指派给队友、追踪依赖链；每个队友有独立上下文、能自主决策；全部协作通过 12 个 `multeam_*` 工具在对话内完成，不离开 DSH。

## 功能

**成员**
- Lead 会话即 Team 根，teammate 是名字唯一且不可重用的 direct child
- `multeam_spawn` 建队友（`context: fresh` 独立上下文 / `fork` 继承当前对话）
- `multeam_send` 双向发消息（running 目标在步边界收到，inactive 目标被唤醒）
- `multeam_broadcast` / `multeam_release` / `multeam_interrupt` 批量操作

**任务板**
- `multeam_task_create` 建任务（`subject`/`description`/`blocked_by`/`write_scopes`）
- `multeam_task_update` 用 revision 做 CAS，支持 claim/reassign/release/reopen
- `blocked_by` 自动做缺失/重复/自引用/环校验
- `write_scopes` 路径前缀冲突在 claim/成员绑定 reassign 时硬拒

**调度器**
- 任务就绪（依赖全部完成）时**自动唤醒 owner**，不需要轮询
- 优先级 / 超时告警 / 负载均衡 / 能力匹配 / 经验传承 / 注入压缩 / 停滞检测 / 重复输出硬中断

**邮箱**
- 消息先进 Lead 日志再投递，进程崩溃后仍能送达
- 60s 投递租约 + 死信兜底，目标消失后自动按死信处理并告警 Lead

**Web 面板**
- 会话头 action + 右侧栏「多人团队」tab
- 成员分组（lead/running/inactive/idle/provisioning/released/failed）
- 任务列表 + 依赖图（可缩放平移）
- 任务详情时间线 + 团队对话记录

## 工具一览

| 工具 | 作用 |
|------|------|
| `multeam_spawn` | 建 teammate |
| `multeam_send` | 发消息 |
| `multeam_list` | 列成员 |
| `multeam_wait` | 等变更（只观察调用之后） |
| `multeam_interrupt` | 打断成员 |
| `multeam_broadcast` | 广播 |
| `multeam_release` | 释放成员 |
| `multeam_task_create` | 建任务 |
| `multeam_task_list` | 列任务 |
| `multeam_task_get` | 查任务 |
| `multeam_task_update` | 改任务（CAS） |
| `multeam_status` | 看团队全景 |

## 接入

把本包加进 DSH profile `package.json` 的 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-multeam"]
    }
  }
}
```

本包自带 `cordis.patch.yml`，挂载时自动完成两件事：

1. **禁用** `tool-subagent*` 系列（让委派与协调统一走 Team 工具）；
2. **以四个不同 `id` 挂载自身**，按 `config.role` 分派安装 core / tools / scheduler 三层，浏览器层由 `dsh.client` 自动注册。

> 注意：**没有 HMR** —— 改动后必须完全重启 DSH 才生效。

## 架构

```
src/
├── index.ts                 # host 入口，按 config.role 分派
├── core/                    # 领域层（零外部服务依赖，全部可单测）
│   ├── types.ts             #   身份品牌 + 持久记录形状
│   ├── error.ts             #   TeamError / errorMessage
│   ├── compress.ts          #   汇报与任务书压缩（纯函数）
│   ├── validation.ts        #   输入归一化（requiredText/writeScope/priority）
│   ├── task-graph.ts        #   依赖图全量校验
│   ├── task-view.ts         #   任务视图派生 + write-scope 冲突检测
│   ├── projection.ts        #   事件溯源折叠 + wire view
│   ├── activity.ts          #   multeam_wait 的一次性等待器
│   ├── lifecycle.ts         #   运行时准入截止 + 有界结算
│   ├── journal.ts           #   串行事务 + 投影失败自愈
│   ├── roster.ts            #   名册 / 可续接子会话 provisioning
│   ├── mailbox.ts           #   邮箱投递 / 租约 / 死信
│   ├── task-board.ts        #   任务命令 + CAS + 授权
│   ├── shapes.ts            #   wait/metrics 等共享形状
│   ├── public.ts            #   稳定公开面（防 bundler 摇树）
│   └── index.ts             #   TeamService 门面
├── tools/                   # 面向模型的工具层
├── scheduler/               # DAG 就绪调度器
└── client/                  # 浏览器面板
    ├── index.ts             # apply / inject
    ├── mount.ts             # slot + sidebar tab 注册
    ├── action.tsx           # 会话头 action
    ├── board.tsx            # 右侧栏团队面板
    ├── shared.ts            # 两个面板共用的纯 helper
    ├── styles.ts            # CSS 字符串 + 类名映射表
    └── locales.ts           # zh / en 字典（键对称）
```

## 开发

```bash
npm install
npm run check     # 构建 + 语法检查 + 全套测试
npm test          # 只跑测试
```

---

<div align="center">

**MIT License** · Copyright © 2026 fenda1-1

</div>
