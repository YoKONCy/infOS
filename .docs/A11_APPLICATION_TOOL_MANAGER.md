# 子应用工具管理层

> **架构基线**：[A10_APPLICATION_INTEGRATION §5.4](./A10_APPLICATION_INTEGRATION.md#54-双向-capability-与-tool-projection)、[M02_CAPABILITY_GATE](./M02_CAPABILITY_GATE.md)
> **最后更新**：2026-10-25

---

## 1. 定位

子应用（Arca、Pictoria 等）通过 `toolProjections` 声明要暴露给主 Agent 的工具。这些声明统一登记到 `ApplicationToolManager`，再由通用 `CapabilityGate` 决定哪个角色、哪个通道可以调用：

```text
子应用内部声明的工具（manifest.toolProjections）
→ 子应用自身适配器（Endpoint / Capability Offer）
→ infOS 侧适配器（ApplicationCapabilityRuntime + 各应用 toolInvocation）
→ 子应用工具管理层（ApplicationToolManager）
→ 工具门禁层（CapabilityGate）
→ 主 Agent
```

管理层只管三件事：一共有哪些子应用工具、各属于哪个子应用、现在是否在线。工具能不能调用，仍由角色能力矩阵、通道约束、请求作用域（ambient / follow_up）和 Thread 级禁用来决定，管理层不为子应用工具另开任何旁路。

社交应用（`apps/social`）仍走原有的 `interact_with_social` 内置入口，不在本层范围内。

## 2. 生命周期

| 阶段 | 行为 |
| --- | --- |
| 装配 | infOS 侧适配器调用 `applicationTools.declare(realm, manifest)`，得到该子应用的 `ApplicationToolDeclaration`。同一子应用只能登记一次。 |
| 上线 | Endpoint 绑定到可用 Offer 后，运行时调用 `declaration.online(name, handler)`。工具经 Realm 以宿主投影注册进 `ToolRegistry`，`packageId` 为 `application:<appId>`。同一次同步中的工具同步完成注册，同时可见。 |
| 下线 | 断线、Offer 撤销、应用被禁用或停止时调用 `offline` / `offlineAll`，工具立即从 `ToolRegistry` 注销，主 Agent 不再可见。 |
| 释放 | Realm 释放时，目录条目随之撤销，之后可以重新登记。 |

离线工具不会留在主 Agent 的可见工具里，符合 A10 §5.4 “不得保留离线占位工具”的要求。它只作为目录条目留在管理层中，方便角色能力配置页提前勾选。

## 3. 冲突与不支持的声明

- 两个子应用声明了同名工具：后登记的那个整体拒绝（`APPLICATION_TOOL_NAME_CONFLICT`），不会只登记一半。
- 与主应用已有工具重名：上线失败并记录日志，原工具不受影响。
- 调用语义为 `open_session`：宿主尚未实现会话通道，登记时跳过并记录日志，其余工具照常工作。`submit_task` 目前与 `invoke` 走同一调用路径。
- 每个声明只能由它所属的子应用上下线（`APPLICATION_TOOL_UNDECLARED`）。

## 4. 能力配置界面

`GET /api/agents/tools` 返回的子应用工具附带两个字段：

```ts
source?: { kind: 'application'; appId: string; appName: string }
available?: boolean // false 表示当前离线，只能提前配置
```

离线工具的 `channels` 按上线后的规则推算：宿主投影不限 source；`group` 通道仍受据点白名单约束。

角色配置页把这些工具单独归入“子应用”分组，显示所属子应用名称，离线时标注“未连接”。角色允许列表中的子应用工具在离线期间也会保留，不会因为修改其他工具开关而被冲掉。

## 5. 接入新的子应用

1. 在子应用 manifest 中声明 `endpoints`、`offeredCapabilities` 和 `toolProjections`。`ApplicationIntegrationService` 会校验投影是否绑定了已声明、已发布的 Operation。
2. 在装配根中注册该子应用的 Realm，并调用 `applicationTools.declare(realm, manifest)`。
3. 把得到的声明凭据交给 `ApplicationCapabilityRuntime`。需要定制调用时，通过 `toolInvocation` 回调扩展。
4. 不要直接调用 `realm.registerTool(..., { hostProjection: true })` 或 `toolRegistry.register` 去暴露子应用工具。
