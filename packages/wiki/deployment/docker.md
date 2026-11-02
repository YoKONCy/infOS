# Docker 部署

Docker 版把 infOS 服务端运行在容器中，通过浏览器访问主界面。你可以在服务器或自己的电脑上部署，再用其他设备连接同一份数据。

## 准备并启动

先安装 Docker 和 Docker Compose，确保设备可以拉取 GitHub Container Registry（GHCR）的镜像。

1. 从 [GitHub Releases](https://github.com/YoKONCy/infOS/releases) 选择要安装的版本，下载该版本附件中的 `docker-compose.yml`，放到单独的部署目录。
2. 在该目录打开终端，执行：

   ```bash
   docker compose up -d
   ```

3. 首次启动需要下载镜像。完成后执行 `docker compose ps` 查看服务状态；前端会等待后端健康检查通过再启动。
4. 在部署机器上打开 `http://localhost:3000`。从其他设备访问时，将 `localhost` 换成部署机器可访问的 IP 或域名，例如 `http://服务器IP:3000`。

Release 附件中的 Compose 文件使用该版本固定的前后端镜像。仓库根目录的 `docker-compose.yml` 用于从源码构建；在仓库根目录执行 `docker compose up -d --build` 可以按仓库内的 Dockerfile 构建并启动。

## 首次登录与配对

首次打开页面时，按当前部署方式登录：

- **已设置 `INFOS_API_TOKEN`**：在登录页选择「管理凭据」，填写该凭据和设备名称，点击「连接此设备」。
- **尚未设置管理凭据，且服务端没有已配对设备**：在部署目录执行 `docker compose logs backend`，找到日志中的首次 Web 管理配对码。在登录页选择「设备配对」，填写配对码和设备名称后连接。配对码五分钟内有效，仅可使用一次；过期后可重启 `backend` 重新获取。

登录后，打开「设置」→「分布式」→「服务访问与设备」，在「配对新设备」填写其他设备可访问的地址，生成二维码或配对码。管理员可以在同一页面撤销设备授权；具体步骤见[分布式](/deployment/distributed)。

配对码和管理凭据都应妥善保管。已有设备时，服务端启动日志不会继续生成首次管理配对码；管理员会话丢失时，可通过配置 `INFOS_API_TOKEN` 恢复管理登录。

## 端口与配置

部署目录中的 Compose 文件读取同目录的 `.env` 文件。常用配置如下；修改后，在部署目录执行 `docker compose up -d`，让相关容器按新配置重建：

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `INFOS_WEB_PORT` | 浏览器访问主界面的宿主机端口。 | `3000` |
| `INFOS_API_TOKEN` | 服务端管理员凭据。 | 留空 |
| `INFOS_PUBLIC_URL` | 供配对使用的公开访问地址，可填写 HTTPS 域名入口。 | 留空 |
| `INFOS_BACKEND_BIND` | 后端业务和能力端口绑定的宿主机地址。 | `127.0.0.1` |
| `INFOS_PORT` | 后端业务端口映射到宿主机的端口。 | `9120` |
| `INFOS_CAPABILITY_PORT` | 能力通道映射到宿主机的端口。 | `9121` |
| `INFOS_LOG_LEVEL` | 后端日志级别。 | `3` |

例如，可以在 `.env` 中填写以下内容，再启动或更新容器：

```dotenv
INFOS_WEB_PORT=3000
INFOS_API_TOKEN=请替换为自己的管理凭据
```

网页入口默认由 `frontend` 发布在宿主机的 `3000` 端口。后端业务和能力端口默认只绑定宿主机回环地址；手机或其他浏览器通过网页入口访问。远程 Electron 客户端或独立能力节点还需要可达的能力通道，请按实际网络、认证和反向代理配置，详见[分布式](/deployment/distributed)。

配对地址填写其他设备实际能访问的 IP 或域名。使用 HTTPS 反向代理时，代理需要支持 WebSocket、Cookie 和流式响应；手机麦克风需要 HTTPS。

## 使用与能力范围

登录后，按照[快速上手](/guide/usage)配置模型和用户人设，再开始聊天。角色、对话和工作区由服务端管理；浏览器负责显示和输入。

Docker 版提供主界面及服务端功能。桌宠、托盘和桌面客户端标签栏由桌面客户端提供；浏览器配对本身提供应用访问。需要桌面操作、内置浏览器等设备能力时，请连接并授权具备相应能力的客户端或节点。

后端镜像包含 Arca 和 Pictoria 的应用资源。可在主界面使用对应入口打开；浏览器需要允许弹出窗口，应用后台与连接状态以页面提示为准。

## 更新、停止与日志

Release 的 Compose 文件固定镜像版本。更新到新版本时，先备份数据，并将部署目录中的 Compose 文件替换为目标版本的 Release 附件；如果改过文件，请先保留自己的配置。然后在部署目录执行：

```bash
docker compose pull
docker compose up -d
```

仓库源码部署可以在更新源码后重新执行 `docker compose up -d --build`。

常用管理命令：

```bash
# 查看服务状态
docker compose ps

# 查看后端日志
docker compose logs --tail=100 backend

# 停止服务并移除容器，保留数据卷
docker compose down
```

默认 Compose 使用 `infos-data` 和 `infos-workspaces` 两个命名卷，分别挂载到容器内的 `/app/data` 和 `/app/workspaces`。角色工作区默认位于服务端数据目录中。Compose 通常会给卷名加上项目名前缀；更新时保持相同的部署目录和项目名，以便继续使用原来的卷。请保留数据卷，并按需要通过应用的「数据与备份」另存备份。

## 备份与恢复

在主界面「设置」→「数据与备份」中，可以导出或导入 `.infos-backup`。导入时按页面提示选择文件、填写所需口令、查看预览并确认导入方案。方案暂存后，在 Docker 部署目录执行：

```bash
docker compose restart backend
```

服务端重启时会先建立恢复点，再应用导入；重启后重新载入界面并检查数据。上传中的浏览器页面需要保持打开，上传完成后可以切换页面查看进度。备份上传上限为 20 GiB，磁盘还需留出解包、暂存和恢复点的空间；如果另设反向代理，也要配置相应上传大小和超时限制。

## 常见问题

- **页面打不开**：运行 `docker compose ps` 和 `docker compose logs --tail=100 backend` 检查状态，再检查端口、服务器地址和防火墙。
- **首次配对码过期**：确认尚无已配对设备且未设置管理凭据，重启 `backend` 后查看新日志。
- **其他设备无法扫码连接**：检查「设备访问地址」是否是目标设备可访问的地址，以及两端网络和端口是否连通。
- **本机模型连接失败**：模型请求由后端容器发起，模型地址中的 `localhost` 指向该容器。请填写后端容器能够访问的模型服务地址，并确认模型服务允许该连接。
- **修改 `.env` 后设置未变化**：在部署目录执行 `docker compose up -d` 应用新配置；`docker compose restart backend` 用于重启现有容器。
- **更新后还是旧版本**：确认部署目录中的 Release Compose 文件已换成目标版本，再执行拉取和启动命令。
