<!--
Description: 说话手册，她从对方那里学到的说话习惯，每个角色一本；只在 speech_handbook 有内容时输出。手册本身存在表达层，不进预设
Prompt Type: component
Direct Consumer: 预设区块
-->
---
label: 手册
---
{% if speech_handbook %}
### 从{{ owner_appellation }}那里学到的说话习惯

{{ speech_handbook }}
{% endif %}
