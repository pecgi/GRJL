# 把 GRJL 部署到飞牛 NAS

目标：让网站在你自己的 NAS 上跑起来，数据存 NAS 自己的硬盘，不再受 Supabase 免费层「7 天不活跃就暂停」的规则影响；同时保留 GitHub 登录，并能通过 Tailscale 从外网访问。

---

## 一、这套方案是什么

| 部分 | 实现 | 说明 |
|---|---|---|
| 网页 | 原本的 HTML 文件 | 只读挂载进容器，改页面不用重建镜像 |
| 后端 | `server.js`（单文件，**零依赖**） | 只用 Node 内置模块，不需要 `npm install` |
| 数据库 | SQLite（`data/grjl.db`） | 一个文件就是一个数据库，直接复制即可备份 |
| 登录 | 自建 GitHub OAuth | 会话用签名 Cookie，30 天免登录 |
| 数据接口 | `/rest/v1/*`（迷你 PostgREST） | 页面原来的调用方式原样兼容，不需要重写前端 |
| 内网穿透 | Tailscale Funnel | 免费、自带 HTTPS、域名固定，OAuth 回调可用 |

数据流：浏览器 → `https://xxx.ts.net`（Tailscale）→ NAS 上的 8080 端口 → `server.js` → `grjl.db`

> 关键点：**所有查询都按登录用户强制隔离**。后端不接受前端传来的 `user_id`，写入时也会强制改写，即使有人拿到公网地址也读不到你的数据。

---

## 二、准备清单

- [ ] NAS 已开启 SSH（飞牛：设置 → 远程访问 → SSH）
- [ ] 一个 Tailscale 账号（免费）：https://login.tailscale.com/start
- [ ] 一个 GitHub 账号（就是你现在用的 pecgi）
- [ ] 现有 Supabase 项目**先恢复到可用状态**（否则旧数据导不出来）

---

## 三、把代码放到 NAS 上

SSH 进 NAS 后：

```bash
# 换成你自己的存储路径。飞牛一般是 /vol1、/vol2，可先用 ls / 看一眼
cd /vol1/docker
git clone https://github.com/pecgi/GRJL.git grjl
cd grjl/nas
```

后续更新只需：

```bash
cd /vol1/docker/grjl && git pull
```

---

## 四、装 Tailscale 并拿到访问地址

```bash
# 官方一键安装（飞牛是 Debian 底子）
curl -fsSL https://tailscale.com/install.sh | sh

# 登录（会打印一个链接，浏览器打开授权）
tailscale up

# 开启 Funnel：把本机 8080 端口发布到公网，自带 HTTPS
tailscale funnel --bg 8080

# 查看域名
tailscale funnel status
```

输出里会出现形如 `https://nas-xxxx.tail1a2b3c.ts.net` 的地址，**记下它**。

> 首次使用 Funnel 需要在 Tailscale 后台开启该功能（管理后台 → DNS/Access controls 里允许 funnel 节点属性），按提示点一下即可。

---

## 五、创建 GitHub OAuth App

打开 https://github.com/settings/developers → **New OAuth App**：

| 字段 | 填什么 |
|---|---|
| Application name | `GRJL NAS` |
| Homepage URL | 上一步拿到的 `https://nas-xxxx.tail1a2b3c.ts.net` |
| Authorization callback URL | 同上地址 **+ `/api/auth/callback`** |

创建后点 **Generate a new client secret**，记下 `Client ID` 和 `Client Secret`。

---

## 六、写配置文件

```bash
cd /vol1/docker/grjl/nas
cp .env.example .env
openssl rand -hex 32          # 生成 SESSION_SECRET，复制输出
nano .env                      # 也可以用 vi
```

需要填四项：

```ini
GITHUB_CLIENT_ID=上面拿到的 Client ID
GITHUB_CLIENT_SECRET=上面拿到的 Client Secret
SESSION_SECRET=openssl 生成的那串
PUBLIC_URL=https://nas-xxxx.tail1a2b3c.ts.net
ALLOWED_LOGIN=pecgi
```

`ALLOWED_LOGIN` 是白名单——只允许你自己的 GitHub 账号登录，等于给公网入口再上一道锁。**建议填上。**

---

## 七、启动

```bash
docker compose up -d --build
docker compose logs -f         # 看到「✅ GRJL 后端已启动」即成功
```

自测（可选但推荐，会验证 77 项功能是否正常）：

```bash
docker compose exec grjl node selftest.js
```

> 自测脚本在镜像里没被打包，如提示找不到，就在本地电脑的仓库目录里跑 `node nas/selftest.js`。

---

## 八、验证登录

浏览器打开 `https://nas-xxxx.tail1a2b3c.ts.net` → 点登录 → 授权 GitHub → 应该直接进入首页，右上角显示你的头像。

进去后逐个页面点一遍，确认列表能加载、能新增/编辑/删除。

---

## 九、导入旧数据

1. 先打开原站点（GitHub Pages）上的 `export-supabase.html`，用 GitHub 登录，会下载一个 `grjl-supabase-backup.json`
   - 注意：这一步需要 Supabase 项目已经恢复，且用的是**迁移前的旧站点**
2. 把 JSON 传到 NAS，例如放到 `/vol1/docker/grjl/nas/`
3. 先演练一遍看看会导入什么：

```bash
docker compose exec grjl node import-backup.js /data/../backup.json --dry-run
```

4. 正式导入：

```bash
# 先看本地用户 id（一般是 1）
docker compose exec grjl node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/grjl.db');console.log(d.prepare('SELECT id,login FROM users').all())"

docker compose exec grjl node import-backup.js /data/../backup.json --user-id 1
```

> 文件路径要在容器内可见。简单做法：把 JSON 拷到 `nas/data/` 下（该目录已挂载为 `/data`），然后用 `/data/grjl-supabase-backup.json`。

5. 回浏览器刷新，核对每个页面的条数。

---

## 十、日常维护

**备份**（数据库就是一个文件，复制即可）：

```bash
cp /vol1/docker/grjl/nas/data/grjl.db ~/grjl-backup-$(date +%F).db
```

也可以走接口导出成 JSON：浏览器登录后访问 `/api/export`。

建议在飞牛的计划任务里加一条每天的备份命令，保留最近 30 份。

**更新页面**：改本地仓库 → `git push` → NAS 上 `git pull`，刷新浏览器即可（HTML 每次都会重新读取）。

**更新后端**：`git pull` 后 `docker compose up -d --build`。

**看日志**：`docker compose logs -f --tail=100`

**停止 / 重启**：`docker compose down` / `docker compose restart`

---

## 十一、常见问题

| 现象 | 原因与处理 |
|---|---|
| 打开地址显示 Tailscale 的错误页 | 容器没起来，或没监听 8080。`docker compose logs` 看日志；`docker compose ps` 看状态 |
| 点登录报 `redirect_uri mismatch` | GitHub OAuth App 里的回调地址和 `.env` 的 `PUBLIC_URL` 不一致，必须完全一致（含 `https://`，结尾是 `/api/auth/callback`） |
| 登录后跳回首页但显示未登录 | 浏览器拦截了 Cookie。确认用的是 `https://...ts.net` 地址而不是 `http://内网IP:8080` |
| 一直卡在「加载中」 | 后端起来了但数据库文件权限不对。`ls -l nas/data`，属主应是容器可读写（root 即可） |
| Funnel 提示未启用 | 去 Tailscale 管理后台开启 Funnel 功能，或改用 `tailscale serve 8080`（仅内网可访问） |
| 数据看着像空的 | 可能导入到了错误的 `user_id`。用上面的方法查 `SELECT user_id, COUNT(*) FROM assets GROUP BY user_id` |
| 想恢复到某个备份 | 停容器 → 用备份文件覆盖 `nas/data/grjl.db` → 启动容器 |

---

## 十二、安全须知

1. **Funnel 会把网站暴露到公网**。数据安全靠两道门：GitHub 登录 + `ALLOWED_LOGIN` 白名单。所以**务必填白名单**。
2. `.env` 里有 Client Secret 和会话密钥，不要提交到 Git（仓库已用 `.gitignore` 排除）。
3. 后端静态托管已屏蔽 `/nas/`、隐藏文件、`.db` 文件，无法通过网页下载源码或数据库。
4. 想更保守：用 `tailscale serve 8080` 代替 Funnel，只有你自己登录 Tailscale 的设备能访问；外网访问时先连上 Tailscale 即可。

---

## 十三、迁移后原站点的处理

页面里的数据接口已改成同源 `/rest/v1/...`，所以 **GitHub Pages 上那份不再能用**（它没有后端）。两种处理：

- **下掉**：GitHub 仓库 Settings → Pages → 关闭，避免留下一个打不开的旧站
- **保留**：只作静态展示用途，但登录和记录功能会失败

建议下掉。NAS 这份就是唯一在用的站点，访问地址即 Tailscale 域名。
