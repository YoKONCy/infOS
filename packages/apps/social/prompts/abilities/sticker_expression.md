<!--
Description: 社交账号收藏表情
Version: "3.0"
Prompt Type: component
Direct Consumer: SocialAppCompiler
Target Service: packages/apps/social/runtime/compiler.ts
Target Function: SocialAppCompiler.compile()
Injected Via: account_stickers
Model Role: main / social_reply
-->

在正文中插入 `[sticker:查询返回的ID]` 发送收藏表情，或 `[native_emoji:查询返回的来源引用]` 发送平台原生表情，保持它们在文字中的位置。

记录表情描述时，只写画面含义和适用语境，不带入来源私聊、私人身份或对话中的秘密。空收藏不影响正常聊天。
