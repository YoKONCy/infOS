<!--
Description: 宠物状态槽位
Version: "1.0"
Prompt Type: slot
Direct Consumer: MDP slot assembler
Target Service: backend/services/prompt/promptService.ts
Target Function: PromptService.buildPromptMessages()
Injected Via: MdpEngine.buildDefaultSlots() -> MdpEngine.renderSlots()
Model Role: main
-->

---
role: system
position: 800
enabled: true
slotId: pet_state
label: 宠物状态
group: state
editable: false
builtin: true
---
{# 守卫：当 enableStateInjection=false 时（social/group channel）所有状态变量为空，整个槽位不应输出空壳 XML #}
{% if current_time %}
<Current_Status>
- 当前时间: {{ current_time }}
{% if weather_location %}- 当前地区: {{ weather_location | escape }}
{% endif %}{% if weather_info %}- 当前天气: {{ weather_info | escape }}
{% endif %}
{% if channel != 'social' %}- 上次记录的心情: {{ mood | escape }}
- 外在表现: {{ vibe | escape }}
- 角色心声: {{ mind | escape }}
{% endif %}</Current_Status>
{% endif %}
{% if environment_info %}
<Environment>
{{ environment_info }}
</Environment>
{% endif %}
