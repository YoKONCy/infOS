import { t as __t } from './i18n.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [tag, output] = process.argv.slice(2)
if (!tag || !/^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag) || !output)
  throw new Error('用法：node scripts/generate-release-notes.mjs <版本标签> <输出文件>')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const commit = git('rev-parse', `${tag}^{commit}`)
let previous = ''
try {
  previous = git('describe', '--tags', '--abbrev=0', `${commit}^`)
} catch {
  // 首个版本没有前序标签，列出截至当前版本的全部提交。
}
const notePath = path.join(root, '.github', 'release-notes', `${tag}.md`)
const summary = fs.existsSync(notePath)
  ? fs.readFileSync(notePath, 'utf8').trim()
  : `## ${tag} 版本更新\n\n本版本的详细改动请参阅下方提交记录。`
const commits = git('log', '--format=- %h %s', previous ? `${previous}..${commit}` : commit)
const body = [
  summary,
  '',
  '### 下载与升级',
  '',
  '- `*-Setup-*.exe`：Windows 安装版，用户数据保存在系统用户目录。',
  '- `*-Portable*.zip`：Windows 便携版，解压后运行，数据保存在程序目录。',
  '- `docker-compose.yml`：固定到本版本的容器部署配置，执行 `docker compose up -d` 启动，访问 `http://localhost:3000`。',
  '- Steam 版由独立构建任务生成，通过 Steam 客户端分发，不上传到此 Release。',
  '- 升级前建议备份用户数据，并正常退出旧版。启动后按存储兼容规则迁移；模型与第三方服务是否需要密钥或其他凭据，以对应服务的认证要求为准。',
  '',
  '### 提交记录',
  '',
  `比较范围：${previous ? previous + ' → ' + tag : '首次发布 → ' + tag}。`,
  '',
  commits || '没有新增提交。',
  '',
  '---',
  '',
  '由 GitHub Actions 自动构建发布。源代码与使用文档见[项目仓库](https://github.com/YoKONCy/infOS)。',
  '',
].join('\n')
fs.writeFileSync(path.resolve(output), body)
console.log(
  __t('scripts.generate-release-notes', '已生成中文发布说明：{0}（上一版本：{1}）', [
    tag,
    previous || '无',
  ]),
)
