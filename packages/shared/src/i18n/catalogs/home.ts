import cn from '../locales/zh-CN/server/home.json'
import tw from '../locales/zh-TW/server/home.json'
import en from '../locales/en-US/server/home.json'
import { registerCatalog } from '../index'
registerCatalog('server.home', 'zh-CN', cn)
registerCatalog('server.home', 'zh-TW', tw)
registerCatalog('server.home', 'en-US', en)
