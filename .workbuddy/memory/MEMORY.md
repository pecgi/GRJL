# 长期记忆

## 用户偏好
- 构建网站时偏好：卡片式 UI + 纯前端本地存储（无需后端）

## 项目整体规划：生活数字记录平台
- 统一入口：index.html（首页登录 + 模块选择，已上线）
- 子模块 1：订阅管理 subscriptions.html（已上线，接入 Supabase 云端同步）
- 子模块 2：日记 diary.html（已上线，纯前端 localStorage 存储，日记覆盖率统计）
- 子模块 3：公众号阅读 wechat-read.html（已上线，RSS+手动收藏混合，Supabase articles 表，支持已读/收藏/按号筛选/标签）
- 子模块 4：Prompt 提示词卡片收集（待开发）
- 子模块 5：笔记摘抄本（待开发）
- 子模块可按需扩展
- 登录逻辑：统一在 index.html 登录（仅 GitHub OAuth），未登录访问子模块自动跳首页

## 项目记录
- `subscriptions.html`：订阅内容管理网站，已接入 Supabase，仅 GitHub 登录，原生 fetch + Bearer token
- `diary.html`：日记覆盖率统计，浅色主题（与首页一致），年份卡片+月份详情，**云端同步**（Supabase diary_entries 表），localStorage 作离线缓存，「记一篇」跳写作页，点月份卡片跳月历页
- `diary-write.html`：简约写日记全页面，标题+正文+日期选择，Ctrl+S 保存，**云端同步**（upsert 写 Supabase + 同步本地缓存）
- `diary-month.html`：月历页面，7列日历网格，有日记高亮绿色+预览，点某天弹出抽屉查看全文或跳写作页，支持月份切换，**云端同步**（按月拉取 Supabase）
- **diary_entries 表**：需在 Supabase SQL Editor 执行建表语句（含 RLS），字段：id/user_id/date/title/body/saved_at，唯一约束 (user_id, date)
- GitHub 仓库：https://github.com/pecgi/GRJL（用户名：pecgi）
- GitHub Pages 地址：https://pecgi.github.io/GRJL/

## 公众号自动收藏探索（2026-03-29，暂停中）
- 目标：每天自动拉取关注公众号更新 → 用户选择 → 自动写入 Supabase wechat-read 页面
- 测试过的方案：RSSHub 公共服务（Cloudflare 拦截）、今天看啥（JS 动态渲染）、搜狗微信搜索（反爬）、feeddd.org（已关闭）、微信官方 API（需登录 token）
- 关注的公众号：老钱日日谈（tobeoldmoney）、楚团长聊聊天（chutuanzhangshuo）
- 下一步备选方案：A=自建 RSSHub 服务器；B=微信 PC 版文件传输助手 + WorkBuddy 扫描
- 当前状态：wechat-read.html 页面保持原样未修改，测试脚本（test-fetch.js/fetch-wechat.js等）留在工作区

## Supabase 配置
- Project URL: https://qknojxdhdjqjdoqjdnyu.supabase.co
- GitHub OAuth App: Client ID = Ov23lir5edpAy7VnhAvO，Callback URL 已配置
- 数据库表：subscriptions（含 RLS 行级安全策略，4条策略：SELECT/INSERT/UPDATE/DELETE，均为 TO authenticated + auth.uid()=user_id）
- GitHub Provider 已在 Supabase Authentication 中开启并保存
- **重要**：anon key 须用 Legacy JWT 格式（eyJ...开头），不能用 publishable key（sb_publishable_...），否则 RLS 验证会卡住无响应
- **重要**：正确的 anon key（subscriptions.html 同款，iat:1774538680）= `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrbm9qeGRoZGpxamRvcWpkbnl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1Mzg2ODAsImV4cCI6MjA5MDExNDY4MH0.8BnUklTASBnzgZgu-_hbcVNoZ_LcUcLCR_9P5y8PWjo`；之前日记文件误用了旧 key（iat:1743004860）导致 401 Unauthorized
- **重要**：supabase-js 库在 GitHub Pages 环境下所有数据库操作（.from().select/insert/update/delete）和 auth.getSession() 都会卡住无响应。已全部改为原生 fetch + Bearer token 方案，从 localStorage['sb-{ref}-auth-token'] 直接读取 access_token，完美解决。
- **重要**：Supabase RLS 要求 upsert 请求体里必须显式传入 `user_id` 字段，否则 403（new row violates row-level security policy）。user_id 从 JWT access_token 中解码获取：`JSON.parse(atob(token.split('.')[1])).sub`。已在 diary-write.html 和 diary.html 中添加 `getUserId()` 函数并在 upsert 请求体里传入。
