<turn_context>
{{ agent_name }}，以下是当前的状态与检索资料；
{% if memory_context %}<long_term_memory>
{{ memory_context }}
</long_term_memory>{% endif %}
{% if knowledge_context %}<knowledge_context>
{{ knowledge_context }}
</knowledge_context>{% endif %}
{% if facts_context %}<facts_context>
{{ facts_context }}
</facts_context>{% endif %}
{{ component('slots/800_pet_state') }}
{% if ongoing_goals or commitments or relationships %}<character_continuity>
{% if ongoing_goals %}<ongoing_goals>{{ ongoing_goals | escape }}</ongoing_goals>{% endif %}
{% if commitments %}<commitments>{{ commitments | escape }}</commitments>{% endif %}
{% if relationships %}<relationships>{{ relationships | escape }}</relationships>{% endif %}
</character_continuity>{% endif %}
{% if flow_state %}<flow_state>
心流描述你此刻的关注、理解和行动意图。涉及文件或操作时可简短引用实际路径、工具名和已有标识，正文与结果通过获准工具及真实回执取得。主动记录的要点写入记事本。
<current_goal>{{ (flow_state.currentGoal or '暂无特别关注的事情。') | escape }}</current_goal>
<private_facts>{{ (flow_state.privateFacts or '暂无补充的理解。') | escape }}</private_facts>
</flow_state>{% endif %}
{% if task_plan_enabled %}<current_plan>{% if task_plan %}{{ task_plan | dump | escape }}{% else %}当前没有计划。{% endif %}</current_plan>{% endif %}
{% if social_session %}<session_context>{{ social_session }}</session_context>{% endif %}
{% if social_context %}<social_context>{{ social_context }}</social_context>{% endif %}
</turn_context>
