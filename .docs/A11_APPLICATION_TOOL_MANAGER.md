# 子应用工具管理层

> **架构基线**：[A10_APPLICATION_INTEGRATION §5.4](./A10_APPLICATION_INTEGRATION.md#54-双向-capability-与-tool-projection)、[M02_CAPABILITY_GATE](./M02_CAPABILITY_GATE.md)
> **最后更新**：2026-10-25

---

## 1. 定位

子应用（Arca、Pictoria 等）在 `toolProjections` 里声明要给主 Agent 用的工具。子应用启动、Endpoint 就绪之后，这些工具才动态注册到 `ApplicationToolManager`；能不能调用，再由通用的 `CapabilityGate` 判定：

```text
子应用内部声明的工具（manifest.toolProjections）
→ 子应用自身适配器（Endpoint / Capability Offer）
→ infOS 侧适配器（ApplicationCapabilityRuntime + 各应用 toolInvocation）
→ 子应用工具管理层（ApplicationToolManager）
→ 工具门禁层（CapabilityGate）
→ 主 Agent
```

管理层只负责回答两个问题：现在有哪些子应用工具在线，它们各属于哪个子应用。调用权限仍按现有规则判定，包括角色能力矩阵、通道约束、请求作用域（ambient / follow_up）和 Thread 级禁用，子应用工具没有任何旁路。

社交应用（`apps/social`）仍走原有的 `interact_with_social` 内置入口，不在本层范围内。

## 2. 生命周期

| 阶段 | 行为 |
| --- | --- |
| 接入 | infOS 侧适配器在装配时调用 `applicationTools.declare(realm, manifest)`，拿到一份只能操作本子应用工具的 `ApplicationToolDeclaration`。这一步不登记、也不注册任何工具。同一子应用只能接入一次。 |
| 上线 | 子应用启动、Endpoint 绑定到可用的 Offer 之后，运行时调用 `declaration.online(name, handler)`，经 Realm 以宿主投影的方式注册进 `ToolRegistry`，`packageId` 为 `application:<appId>`。注册是同步完成的，所以同一次同步里的工具会同时出现。 |
| 下线 | 断线、Offer 撤销、应用被禁用或停止时，调用 `offline` / `offlineAll`。工具会立即从 `ToolRegistry` 和管理层中整条移除。 |
| 释放 | Realm 释放时，接入记录和在线工具一并撤销，之后可以重新接入。 |

子应用工具不会常驻工具列表。子应用没启动、或已经断开时，主 Agent 的工具定义、角色能力配置页和会话工具菜单里都看不到它的工具，这符合 A10 §5.4 “不得保留离线占位工具”的要求。

## 3. 排序与提示词缓存

动态工具上下线时，应尽量不让模型的提示词缓存失效。因此：

- `services/agent/toolOrder.ts` 提供统一的比较函数 `compareToolNames`：常驻工具排在前面，动态工具排在后面，两组内部都沿用原来的函数名字母序。
- 发给模型的函数定义（`canonicalTools`）和系统提示词中的工具说明（`CapabilityGate.describeTools`）都使用这个顺序。
- 装配根通过 `setDynamicToolPredicate((name) => applicationTools.has(name))`，把在线的子应用工具标记为动态工具。

这样一来，子应用上线或下线只会改动工具列表的末尾，前面常驻工具那一段保持不变。独立子应用进程没有注入这条判定，排序和原来一样。

## 4. 冲突与不支持的声明

- 工具名与已在线的其他子应用工具，或主应用工具重名：上线失败并记录日志，已有工具不会被覆盖。
- 调用语义为 `open_session`：宿主还没有实现会话通道，接入时跳过并记录日志，其余工具照常工作。`submit_task` 目前与 `invoke` 走同一条调用路径。
- 每个子应用只能上下线自己 manifest 里声明过的工具（否则报 `APPLICATION_TOOL_UNDECLARED`）。

## 5. 能力配置界面

`GET /api/agents/tools` 返回的列表中，在线的子应用工具会多带一个字段：

```ts
source?: { kind: 'application'; appId: string; appName: string }
```

角色配置页会把这些工具单独归入排在最后的“子应用”分组，并显示所属子应用的名称。

### 角色勾选与 `application:*`

子应用工具不常驻列表，所以不能靠“逐个列出工具名”来记住角色的授权：子应用离线时修改别的开关，前端只能看到在线工具，逐个展开会把离线子应用的工具丢掉。为此沿用 `mcp:*` 的做法：

- 角色能力配置里写 `application:*`，表示“放行当前在线的全部子应用工具”，判定依据是工具 `packageId` 以 `application:` 开头。和 `mcp:*` 一样，只在默认作用域生效，ambient / follow_up 作用域不受影响。
- 前端从 `*` 展开为显式列表时，普通工具逐个列出，子应用工具统一写成 `application:*`。
- 在通配符状态下关闭某个子应用工具时，改为逐个列出其余在线的子应用工具。

修复说明：通配符不是真实工具名，原实现在按通道工具求交集时就已经把它过滤掉了，`mcp:*` 因此从未生效。现在两个通配符都直接从角色配置中读取。

## 6. 接入新的子应用

1. 在子应用 manifest 中声明 `endpoints`、`offeredCapabilities` 和 `toolProjections`。`ApplicationIntegrationService` 会校验每个投影是否绑定了已声明、并且已发布的 Operation。
2. 在装配根注册该子应用的 Realm，然后调用 `applicationTools.declare(realm, manifest)`。
3. 把得到的接入凭据交给 `ApplicationCapabilityRuntime`。如果需要定制调用方式，通过 `toolInvocation` 回调扩展。
4. 不要直接调用 `realm.registerTool(..., { hostProjection: true })` 或 `toolRegistry.register` 来暴露子应用工具。
