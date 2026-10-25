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
{% if flow_state %}<flow_state>
<current_goal>{{ (flow_state.currentGoal or '暂无明确的持续目标。') | escape }}</current_goal>
<private_facts>{{ (flow_state.privateFacts or '暂无需要私下持续记住的事实。') | escape }}</private_facts>
</flow_state>{% endif %}
{% if task_plan_enabled %}<current_plan>{% if task_plan %}{{ task_plan | dump | escape }}{% else %}当前没有计划。{% endif %}</current_plan>{% endif %}
{% if social_session %}<session_context>{{ social_session }}</session_context>{% endif %}
{% if social_context %}<social_context>{{ social_context }}</social_context>{% endif %}
</turn_context>
