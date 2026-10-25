import {
  type SocialActionDefinition,
  type SocialBusinessTool,
  type SocialParameters,
} from '@infos/shared'

const text = (description: string, maxLength = 500) => ({ type: 'string', description, maxLength })
const id = (description = '标识') => ({ ...text(description, 200), minLength: 1 })
const qq = (description = 'QQ 号') => ({ ...id(description), pattern: '^[1-9][0-9]{4,19}$' })
const integer = (description: string, minimum = 0, maximum = 100) => ({
  type: 'integer',
  description,
  minimum,
  maximum,
})
const boolean = { type: 'boolean' }
const choice = (...values: Array<string | number>) => ({ type: typeof values[0], enum: values })
const list = (items: SocialParameters, maxItems = 20) => ({ type: 'array', items, maxItems })
const object = (properties: SocialParameters, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const user = { user_id: qq() }
const group = { group_id: qq('群号') }
const message = { message_id: id('消息 ID') }
const media = { ...group, album_id: id('相册 ID'), lloc: id('媒体 ID') }
const post = { post_id: id('查询返回的空间记录 ID') }
const source = text('资源链接、工作区路径或 attachment:附件ID', 2048)
const actions: SocialActionDefinition[] = []
function add(
  tool: SocialBusinessTool,
  action: string,
  description: string,
  properties: SocialParameters = {},
  required: string[] = [],
  options: Partial<
    Omit<SocialActionDefinition, 'tool' | 'action' | 'description' | 'parameters'>
  > = {},
) {
  actions.push({
    tool,
    action,
    description,
    parameters: object(properties, required),
    mutation: false,
    ownerOnly: false,
    ...options,
  })
}
const write = { mutation: true }
const manage = { mutation: true, ownerOnly: true }
const groupManage = { ...manage, groupRole: 'admin' as const }
const groupOwner = { ...manage, groupRole: 'owner' as const }

add('social', 'contacts_list', '查询好友')
add('social', 'contact_get', '查询联系人资料', user, ['user_id'])
add(
  'social',
  'contact_remark',
  '修改好友备注',
  { ...user, remark: text('备注', 100) },
  ['user_id', 'remark'],
  manage,
)
add('social', 'contact_remove', '删除好友', user, ['user_id'], manage)
add(
  'social',
  'friend_request',
  '接受或拒绝好友申请',
  { flag: id('申请标识'), approve: boolean, remark: text('备注', 100) },
  ['flag', 'approve'],
  manage,
)
add('social', 'poke', '戳一戳', { ...user, ...group }, ['user_id'], { ...write, feature: 'packet' })
add(
  'social',
  'profile_like',
  '点赞资料卡',
  { ...user, times: integer('次数', 1, 10) },
  ['user_id'],
  write,
)
add(
  'social',
  'message_react',
  '回应消息表情',
  { ...message, emoji_id: id('表情 ID'), set: boolean },
  ['message_id', 'emoji_id'],
  write,
)
add(
  'social',
  'message_recall',
  '撤回消息；撤回群内他人消息需要群管理权限',
  message,
  ['message_id'],
  manage,
)
add(
  'social',
  'mark_read',
  '标记会话已读',
  { channel_id: qq('会话 QQ 号或群号'), channel_type: choice('private', 'group') },
  ['channel_id', 'channel_type'],
  write,
)
add(
  'social',
  'history_get',
  '查询平台历史消息',
  {
    channel_id: qq('会话 QQ 号或群号'),
    channel_type: choice('private', 'group'),
    count: integer('数量', 1, 50),
    message_seq: integer('上页消息序号', 0, Number.MAX_SAFE_INTEGER),
  },
  ['channel_id', 'channel_type'],
)
add('social', 'forward_read', '读取合并转发', { forward_id: id('转发 ID') }, ['forward_id'])
add(
  'social',
  'image_read',
  '按来源消息读取图片像素；历史中的图片占位或名称不代表已经看过画面',
  { message_ids: list(id('消息 ID'), 3), max_images: integer('图片数量', 1, 3) },
  ['message_ids'],
  { legacy: 'social_read_image' },
)
add('social', 'emoji_list', '查询当前会话的 QQ 原生系统/商城表情来源及已记录引用', {
  message_ids: list(id('来源消息 ID'), 10),
})
add(
  'social',
  'emoji_remember',
  '把当前会话原生表情来源记录到角色的账号表情引用库，跨会话复用；不会加入 QQ 图片收藏，来源删除后失效',
  { reference: id('emoji_list 返回的来源引用'), description: text('描述', 200) },
  ['reference'],
  write,
)
add(
  'social',
  'contact_remember',
  '更新联系人印象',
  {
    ...user,
    display_name: text('名字', 100),
    identity: text('身份'),
    impression: text('印象'),
    source_channel_id: id('来源会话'),
  },
  ['user_id', 'impression'],
  { ...write, legacy: 'social_remember_contact_impression' },
)
add(
  'social',
  'contact_history',
  '回顾与联系人的互动',
  {
    ...user,
    ...group,
    private_limit: integer('私聊数量', 1, 50),
    group_limit: integer('群聊数量', 1, 80),
    self_message_limit: integer('自身发言数量', 1, 20),
  },
  ['user_id'],
  { legacy: 'social_get_contact_history', ownerOnly: true },
)
add(
  'social',
  'send_resource',
  '发送资源到当前会话',
  { source, caption: text('说明', 300) },
  ['source'],
  { ...write, legacy: 'send_file' },
)
add(
  'social',
  'message_send',
  '发送消息到指定会话',
  {
    channel_id: qq('目标 QQ 号或群号'),
    channel_type: choice('private', 'group'),
    content: text('正文', 10000),
  },
  ['channel_id', 'channel_type', 'content'],
  manage,
)
for (const action of ['list', 'search', 'read', 'collect', 'describe', 'delete']) {
  const parameters: Record<string, [SocialParameters, string[]]> = {
    list: [
      { offset: integer('起始位置', 0, 4096), limit: integer('数量', 1, 60), refresh: { ...boolean, description: '跳过缓存重新读取收藏；核验结果不明的收藏写入时使用' } },
      [],
    ],
    search: [
      { query: text('关键词', 200), limit: integer('数量', 1, 60), refresh: { ...boolean, description: '跳过缓存重新读取收藏' } },
      ['query'],
    ],
    read: [{ sticker_id: id('表情 ID') }, ['sticker_id']],
    collect: [
      {
        message_id: id('来源消息 ID'),
        image_index: integer('图片序号', 1, 20),
        description: text('描述', 200),
      },
      ['message_id'],
    ],
    describe: [
      { sticker_id: id('表情 ID'), description: text('描述', 200) },
      ['sticker_id', 'description'],
    ],
    delete: [{ sticker_id: id('表情 ID') }, ['sticker_id']],
  }
  const [properties, required] = parameters[action]!
  add(
    'social',
    `sticker_${action}`,
    `收藏表情：${{ list: '查询', search: '搜索', read: '查看', collect: '收藏', describe: '描述', delete: '删除' }[action]}`,
    properties,
    required,
    {
      legacy: 'social_sticker',
      mutation: ['collect', 'describe', 'delete'].includes(action),
      feature: 'stickers',
    },
  )
}
add('social', 'owner_private_only', '切换仅主人私聊模式', { enabled: boolean }, ['enabled'], {
  ...manage,
  legacy: 'social_set_owner_private_only',
})
add('social', 'diary_list', '列出自己的日记', { limit: integer('数量', 1, 60) }, [], {
  ownerOnly: true,
  legacy: 'social_read_diary',
})
add(
  'social',
  'diary_read',
  '读取自己的日记',
  { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
  [],
  { ownerOnly: true, legacy: 'social_read_diary' },
)
for (const action of ['send', 'get_design', 'save_design', 'reset_design']) {
  const design = object(
    {
      title: text('标题', 32),
      theme: choice('light', 'dark'),
      accent: choice('sky', 'pink', 'mint', 'amber'),
      layout: choice('grid', 'stack'),
      sections: {
        ...list(choice('cpu', 'memory', 'gpu', 'disk', 'tasks'), 5),
        minItems: 1,
        uniqueItems: true,
      },
    },
    ['title', 'theme', 'accent', 'layout', 'sections'],
  )
  add(
    'social',
    `status_card_${action}`,
    `状态卡片：${{ send: '发送', get_design: '读取设计', save_design: '保存设计', reset_design: '重置设计' }[action]}`,
    action === 'send' || action === 'save_design' ? { design } : {},
    action === 'save_design' ? ['design'] : [],
    { ownerOnly: true, mutation: action !== 'get_design', legacy: 'social_status_card' },
  )
}

add('social_group', 'list', '查询群列表')
add('social_group', 'info', '查询群资料', group, ['group_id'])
add('social_group', 'members', '查询群成员', group, ['group_id'])
add('social_group', 'member_get', '查询单个群成员', { ...group, ...user }, ['group_id', 'user_id'])
add(
  'social_group',
  'card_set',
  '修改群名片',
  { ...group, ...user, card: text('名片', 100) },
  ['group_id', 'card'],
  write,
)
add(
  'social_group',
  'name_set',
  '修改群名',
  { ...group, group_name: text('群名', 100) },
  ['group_id', 'group_name'],
  groupManage,
)
add(
  'social_group',
  'portrait_set',
  '修改群头像',
  { ...group, source },
  ['group_id', 'source'],
  groupManage,
)
add(
  'social_group',
  'ban',
  '禁言或解除禁言',
  { ...group, ...user, duration: integer('秒数，0 表示解除', 0, 2592000) },
  ['group_id', 'user_id', 'duration'],
  groupManage,
)
add(
  'social_group',
  'whole_ban',
  '切换全员禁言',
  { ...group, enable: boolean },
  ['group_id', 'enable'],
  groupManage,
)
add(
  'social_group',
  'kick',
  '移除群成员',
  { ...group, ...user, reject_add_request: boolean },
  ['group_id', 'user_id'],
  groupManage,
)
add(
  'social_group',
  'admin_set',
  '设置或取消管理员',
  { ...group, ...user, enable: boolean },
  ['group_id', 'user_id', 'enable'],
  groupOwner,
)
add(
  'social_group',
  'title_set',
  '设置专属头衔',
  { ...group, ...user, special_title: text('头衔', 100) },
  ['group_id', 'user_id', 'special_title'],
  { ...groupOwner, feature: 'packet' },
)
add('social_group', 'requests', '查询入群申请', group, ['group_id'], {
  ownerOnly: true,
  groupRole: 'admin',
})
add(
  'social_group',
  'request_handle',
  '处理入群申请',
  { ...group, flag: id('申请标识'), approve: boolean, reason: text('理由', 200) },
  ['group_id', 'flag', 'approve'],
  groupManage,
)
add('social_group', 'leave', '退出群聊', { ...group, is_dismiss: boolean }, ['group_id'], manage)
add('social_group', 'notices', '读取群公告', group, ['group_id'])
add(
  'social_group',
  'notice_publish',
  '发布群公告',
  { ...group, content: text('公告', 5000), source, pinned: boolean },
  ['group_id', 'content'],
  groupManage,
)
add(
  'social_group',
  'notice_delete',
  '删除群公告',
  { ...group, notice_id: id('公告 ID') },
  ['group_id', 'notice_id'],
  groupManage,
)
add('social_group', 'essence_list', '查询精华消息', group, ['group_id'])
add(
  'social_group',
  'essence_set',
  '添加精华消息',
  { ...group, ...message },
  ['group_id', 'message_id'],
  groupManage,
)
add(
  'social_group',
  'essence_remove',
  '移除精华消息',
  { ...group, ...message },
  ['group_id', 'message_id'],
  groupManage,
)
add(
  'social_group',
  'files',
  '查询群文件',
  { ...group, folder_id: id('文件夹 ID'), file_count: integer('数量', 1, 100) },
  ['group_id'],
)
add(
  'social_group',
  'file_url',
  '查询群文件下载链接',
  { ...group, file_id: id('文件 ID') },
  ['group_id', 'file_id'],
  { feature: 'packet' },
)
add(
  'social_group',
  'file_delete',
  '删除群文件',
  { ...group, file_id: id('文件 ID') },
  ['group_id', 'file_id'],
  groupManage,
)
add(
  'social_group',
  'folder_create',
  '新建群文件夹',
  { ...group, folder_name: text('文件夹名', 100) },
  ['group_id', 'folder_name'],
  groupManage,
)
add(
  'social_group',
  'folder_delete',
  '删除群文件夹',
  { ...group, folder_id: id('文件夹 ID') },
  ['group_id', 'folder_id'],
  groupManage,
)
add(
  'social_group',
  'file_rename',
  '重命名群文件',
  {
    ...group,
    file_id: id('文件 ID'),
    current_parent_directory: id('当前目录'),
    new_name: text('新文件名', 200),
  },
  ['group_id', 'file_id', 'current_parent_directory', 'new_name'],
  { ...groupManage, feature: 'packet' },
)
add('social_group', 'albums', '查询群相册', { ...group, attach_info: text('分页游标', 2000) }, [
  'group_id',
])
add(
  'social_group',
  'album_media',
  '查询相册内容',
  { ...group, album_id: id('相册 ID'), attach_info: text('分页游标', 2000) },
  ['group_id', 'album_id'],
)
add(
  'social_group',
  'album_upload',
  '上传相册图片',
  { ...group, album_id: id('相册 ID'), album_name: text('相册名', 100), sources: list(source, 9) },
  ['group_id', 'album_id', 'album_name', 'sources'],
  write,
)
add(
  'social_group',
  'album_comment',
  '评论相册图片',
  { ...media, content: text('评论', 2000) },
  ['group_id', 'album_id', 'lloc', 'content'],
  write,
)
add(
  'social_group',
  'album_like',
  '点赞或取消相册点赞',
  { ...media, batch_id: id('上传批次 ID'), set: boolean },
  ['group_id', 'album_id', 'batch_id'],
  write,
)
add(
  'social_group',
  'album_delete',
  '删除相册图片',
  media,
  ['group_id', 'album_id', 'lloc'],
  groupManage,
)

add('social_account', 'profile_get', '查询自己的 QQ 资料')
add(
  'social_account',
  'operations',
  '查询操作记录和结果不明的操作',
  { limit: integer('数量', 1, 50) },
  [],
  { ownerOnly: true },
)
add(
  'social_account',
  'operation_resolve',
  '主人核验实际结果后标记操作状态',
  { operation_id: id('操作 ID'), decision: choice('completed', 'not_sent') },
  ['operation_id', 'decision'],
  manage,
)
add(
  'social_account',
  'profile_update',
  '修改自己的 QQ 资料',
  { nickname: text('昵称', 100), signature: text('签名', 500), sex: choice(0, 1, 2) },
  [],
  manage,
)
add(
  'social_account',
  'signature_set',
  '修改签名',
  { signature: text('签名', 500) },
  ['signature'],
  manage,
)
add('social_account', 'avatar_set', '修改 QQ 头像', { source }, ['source'], manage)
add(
  'social_account',
  'status_set',
  '修改在线状态',
  {
    status: choice('online', 'away', 'busy', 'dnd', 'invisible', 'qme'),
    ext_status: integer('扩展状态', 0, 10000),
    battery: integer('电量', 0, 100),
  },
  ['status'],
  manage,
)
add(
  'social_account',
  'status_custom',
  '设置自定义状态',
  { face_id: id('状态图标 ID'), wording: text('状态文字', 100), face_type: id('图标类型') },
  ['face_id', 'wording'],
  manage,
)
add(
  'social_account',
  'qzone_publish',
  '发布文字或多图说说',
  {
    content: text('正文', 10000),
    sources: list(source, 9),
    visibility: choice('public', 'friends', 'selected', 'private', 'exclude'),
    target_uins: list(qq(), 100),
  },
  ['content', 'visibility'],
  { ...manage, feature: 'qzone' },
)
add(
  'social_account',
  'qzone_records',
  '查询本应用的说说发布记录',
  { limit: integer('数量', 1, 50) },
  [],
  { ownerOnly: true },
)
add('social_account', 'qzone_delete', '删除自己的说说', { tid: id('说说 ID') }, ['tid'], {
  ...manage,
  feature: 'qzone',
})
add(
  'social_account',
  'qzone_feed',
  '浏览好友动态',
  { page: integer('页码', 1, 100), count: integer('数量', 1, 30) },
  [],
  { feature: 'qzone', ownerOnly: true },
)
add(
  'social_account',
  'qzone_list',
  '浏览自己或好友的说说',
  { ...user, offset: integer('起始位置', 0, 10000), count: integer('数量', 1, 30) },
  [],
  { feature: 'qzone', ownerOnly: true },
)
add('social_account', 'qzone_detail', '读取说说和评论', post, ['post_id'], {
  feature: 'qzone',
  ownerOnly: true,
})
add('social_account', 'qzone_like', '点赞说说', post, ['post_id'], { ...manage, feature: 'qzone' })
add(
  'social_account',
  'qzone_comment',
  '评论说说',
  { ...post, content: text('评论', 2000) },
  ['post_id', 'content'],
  { ...manage, feature: 'qzone' },
)
add(
  'social_account',
  'qzone_repost',
  '转发说说',
  { ...post, content: text('附言', 2000) },
  ['post_id'],
  { ...manage, feature: 'qzone' },
)

export const NAPCAT_ACTIONS: readonly SocialActionDefinition[] = actions
