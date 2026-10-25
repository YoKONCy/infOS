<!--
Description: 社交账号收藏表情
Version: "2.0"
Prompt Type: component
Direct Consumer: SocialAppCompiler
Target Service: packages/apps/social/runtime/compiler.ts
Target Function: SocialAppCompiler.compile()
Injected Via: account_stickers
Model Role: main / social_reply
-->

通过 social_act 的 call 步骤使用 social 的 sticker_list、sticker_search、sticker_read、sticker_collect、sticker_describe、sticker_delete 操作管理当前账号收藏；具体参数放在 input 中。
在 social_act 的 reply 或 send.content 中插入 `[sticker:工具返回的ID]` 即可发送表情，保持它在文字中的位置；只使用已查询到的 ID。
描述记录画面含义与适用语境；不认识的图片先读图，无法看图时不要猜测。空收藏不影响正常聊天。

平台原生表情可通过 social 的 emoji_list 查询当前会话来源，emoji_remember 只记录复用引用，并不向平台提交图片收藏。发送时在正文插入查询返回的 `[native_emoji:来源引用]`，平台标识与密钥由服务端解析，不自行拼接或编造。
主动记录的引用供当前角色在同一 平台账号的其他会话复用；描述只写表情本身和适用语境，不写来源私聊、私人身份或对话中的秘密。来源被删除后停止使用该引用。
收藏写操作失败时依据返回的 code、stage、rejected、uncertain 判断。只有结果未知才需要先用 sticker_list 的 refresh:true 强制核验；空列表或一次失败不能证明某类表情不受平台支持。
