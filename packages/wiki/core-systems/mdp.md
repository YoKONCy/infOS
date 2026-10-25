# MDP 系统 (Modular Dynamic Prompt)

MDP (Modular Dynamic Prompt) 是 infOS 的核心提示词管理系统。它通过模块化、动态渲染和基于角色的覆盖机制，解决了长上下文遗忘、多角色管理复杂以及提示词难以维护的问题。

## 1. 核心设计理念

1.  **模块化 (Modularity)**: 将庞大的 System Prompt 拆解为细粒度的组件（如 `rules`, `abilities`, `personas`），通过组合构建最终提示词。
2.  **动态性 (Dynamism)**: 基于 **Jinja2** 引擎，支持运行时根据上下文（如当前时间、用户状态、Agent 记忆、NIT 工具描述）动态注入变量。
3.  **继承与覆盖 (Inheritance & Override)**: 支持基于 Agent 身份的差异化配置，子 Agent 可以继承通用模板并覆盖特定组件。
4.  **三明治结构 (Sandwich Structure)**: 通过 `header` 和 `footer` 分离核心指令与约束，防止模型在长上下文中产生“注意力溃散”。
5.  **递归展开 (Recursive Expansion)**: 支持高达 5 层的嵌套变量引用，实现复杂的提示词逻辑。

## 2. 系统架构

MDP 由 [manager.py](file:///c:/Users/Administrator/OneDrive/桌面/infOS/backend/services/mdp/manager.py) 中的 `MDPManager` 统一管理。

<MDPGraph />

## 3. 目录结构

MDP 的源码位于 `backend/services/mdp`，其核心目录结构如下：

```markdown
backend/services/mdp/
├── manager.py # 核心管理器 (MDPManager)
├── prompts/ # 通用提示词仓库 (Base Library)
│ ├── templates/ # 顶层组装模板 (如 social.md, work.md)
│ ├── components/ # 基础功能组件 (rules, abilities)
│ ├── group/ # 群聊场景专用逻辑
│ ├── social/ # 社交模式专用规则
│ └── tasks/ # 特定任务提示词 (如 memory/reflection)
└── agents/ # Agent 专属覆盖区 (Overrides)
├── pero/ # Pero 的专属人设与配置
└── nana/ # Nana 的专属人设与配置
```

## 4. 核心功能详解

### 4.1 模板组装与递归渲染

所有的提示词文件（`.md`）都被视为一个组件。`MDPManager` 会递归地解析 `{{ component_name }}`。

**递归示例**:

- `templates/social.md` 引用 `{{ system_core }}`。
- `system_core` 可能引用 `{{ security_rules }}`。
- 最终渲染时，系统会递归展开所有引用，直到没有 `{{ }}` 或达到 5 层上限。

### 4.2 Agent 覆盖机制 (Context-Aware Override)

当调用 `mdp.render("template_name", context)` 且 `context` 中包含 `agent_name` 时，系统会执行以下查找逻辑：

1.  **优先**: `agents/{agent_name}/{template_name}.md`
2.  **次之**: `prompts/{template_name}.md`

这使得我们可以为 "Pero" 和 "Nana" 编写完全不同的 `system_prompt.md`，但在业务逻辑中只需调用 `mdp.render("system_prompt", {"agent_name": "pero"})`。

### 4.3 三明治渲染 (Header/Footer Blocks)

为了确保模型在长上下文（包含大量记忆、搜索结果等）下依然遵循输出约束，MDP 采用了 `header` 和 `footer` 块：

**在模板中定义**:

```markdown
{% block header %}
<System_Context>
{{ system_core }}
</System_Context>
{% endblock %}

{% block footer %}
<Instruction_Context>
{{ output_constraints }}
</Instruction_Context>
{% endblock %}
```

**在代码中调用**:

```python
blocks = mdp.render_blocks("templates/social", context)
# 组装方式：[Header] + [Dynamic Content (RAG/History)] + [Footer]
final_prompt = f"{blocks['header']}\n\n{rag_content}\n\n{blocks['footer']}"
```

### 4.4 结构化标签 (XML Tags)

为了提高大模型对提示词的理解深度，MDP 推荐使用 XML 风格的标签来包裹不同维度的内容：

- `<System_Context>`: 核心系统定义。
- `<Context>`: 当前环境变量、活动窗口、近期记忆。
- `<Instruction_Context>`: 当前任务的具体操作指南和 NIT 协议约束。

### 4.5 [PASS] 决策机制

在 `social/social_rules.md` 中，MDP 定义了一套双重思考决策机制：

- 如果模型处于 **ACTIVE_OBSERVATION** (活跃观察) 模式，它会先判断话题相关性。
- 如果不相关，模型仅输出 `[PASS]`，业务层将截获此标识并跳过该轮回复，节省 Token 消耗。

## 5. 开发规范

- **路径即 Key**: 引用组件时使用相对路径，如 `{{ tasks/memory/summary }}`。
- **元数据声明**: 在文件头部使用 HTML 注释或 YAML Frontmatter 声明 `description` 和 `version`。
- **原子化**: 每个组件应保持单一职责，例如 `vision.md` 只描述视觉能力。
- **去除注释**: `MDPManager` 在渲染时会自动剥离 `<!-- -->` 风格的 HTML 注释，确保调试信息不进入最终提示词。

## 6. 通用占位符汇总 (Placeholder Reference)

<div v-pre>

在 MDP 提示词体系中，以下占位符会被 `MDPManager` 或业务逻辑动态注入：

### 6.1 身份与关系 (Identity)

- `{{ agent_name }}`: 当前 AI 代理的名字（如 Pero, Nana）。
- `{{ owner_name }}` / `{{ user }}`: 主人的称呼或用户名。
- `{{ owner_qq }}`: 主人的 QQ 号（仅社交模式）。
- `{{ user_persona }}`: 用户自定义的背景设定或偏好。

### 6.2 运行时环境 (Runtime Context)

- `{{ current_time }}`: 当前系统时间。
- `{{ current_mode }}`: 交互模式（如 `SUMMONED` 被召唤, `ACTIVE_OBSERVATION` 观察中）。
- `{{ mood }}` / `{{ vibe }}` / `{{ mind }}`: Agent 的即时情绪、氛围感和心理活动描述。
- `{{ active_windows }}`: 当前操作系统中活跃的窗口列表。
- `{{ vision_status }}`: 视觉/屏幕观察系统的当前状态。

### 6.3 记忆与历史 (Memory & History)

- `{{ memory_context }}`: 从向量数据库检索出的长期记忆片段。
- `{{ graph_context }}`: 从知识图谱中提取的相关实体与关系。
- `{{ recent_history_context }}`: 最近几轮的对话上下文。
- `{{ flattened_group_history }}`: 格式化后的群聊历史记录。
- `{{ flattened_desktop_history }}`: 格式化后的桌面操作/事件历史。

### 6.4 能力与工具 (Abilities)

- `{{ ability_nit }}`: NIT 协议工具的详细定义与调用说明。
- `{{ available_tools_desc }}`: 简化的可用工具功能列表。
- `{{ nit_id }}`: 本轮对话生成的唯一工具调用序列号。

### 6.5 系统组件 (Core Components)

- `{{ system_core }}`: 核心系统指令（所有模式共享）。
- `{{ persona_definition }}`: Agent 的核心人设定义。
- `{{ output_constraint }}`: 强制性的输出格式约束（如 JSON、Markdown 限制）。
- `{{ social_rules }}`: 社交模式下的身份、参与方式与失败恢复指导。

</div>
