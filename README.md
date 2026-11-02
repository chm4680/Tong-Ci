# 同词相遇（联想词收敛小游戏）

朋友聚会用的小游戏：所有人从一个初始词出发各自联想，每轮展示大家的词，直到**所有人想到完全相同的词**，游戏结束。

## 游戏规则

1. 每人输入一个初始词，全部提交后向所有人展示
2. 倒计时内，每人根据上一轮展示的所有词联想一个新词提交；**全员提交后立即公示**（提交后可撤回修改）
3. 公示所有人的词，**所有人点「确认」后才进入下一轮**，重复联想，直到所有人想到完全相同的词
4. 倒计时结束仍无人提交，游戏自动结束

## 积分（仅本局有效，每局从 0 开始，不保留历史）

- 每轮同步奖励：你的词与至少一名其他人的词相同 +10；词与众不同的玩家本轮不得分
- 相遇成功（全员同词）：每人 +50
- 速度奖励：第 1 轮相遇 +90，第 2 轮 +80……第 10 轮起为 0

## 本地试玩（可选）

1. 到 https://nodejs.org 下载安装 Node.js（选 LTS 版本，安装一路点"下一步"）
2. 按 `Win + R`，输入 `cmd` 回车，打开命令行
3. 进入本文件夹后依次输入：
   ```
   npm install
   npm start
   ```
4. 浏览器打开 http://localhost:3000
5. 朋友在同一 WiFi 下，用手机浏览器打开 `http://你电脑的IP:3000`
   （查 IP：命令行输入 `ipconfig`，找"IPv4 地址"那行）

## 部署上线（免费，手机随时能玩）

### 第一步：注册 GitHub 并上传代码

1. 打开 https://github.com 注册账号（用邮箱即可，免费）
2. 点右上角 `+` → `New repository`
3. Repository name 填 `tongci`，选 `Public`，点 `Create repository`
4. 在仓库页面点 `uploading an existing file` 链接
5. 把本项目的 **4 个文件**（package.json、server.js、.gitignore、public 文件夹）全部拖进网页，点 `Commit changes`
   - 注意：不要上传 `node_modules` 文件夹（.gitignore 会自动忽略它）

### 第二步：注册 Render 并部署

1. 打开 https://render.com ，点 `Get Started`，用 GitHub 账号登录
2. 点顶部 `New +` → `Web Service`
3. 在列表里选择刚创建的 `tongci` 仓库（找不到就点 `Connect account` 授权）
4. 填写以下内容，其余保持默认：
   - Name：`tongci`（随意）
   - Runtime：`Node`
   - Build Command：`npm install`
   - Start Command：`node server.js`
   - Instance Type：选 `Free`
5. 点 `Create Web Service`，等 2-3 分钟
6. 部署完成后，页面顶部会显示一个网址，形如 `https://tongci-xxxx.onrender.com`
7. 把这个网址发给朋友，大家用手机浏览器打开就能玩

### 注意事项

- Render 免费版：**15 分钟没人玩会休眠**，之后第一次打开要等 30-60 秒才能用（这是正常的）
- 积分只在本局内计算，每局开始自动清零
- 同一房间内昵称不能重复；中途断网重进：输入相同昵称和房间码即可回到房间
- 初始词提交后不可修改；每轮的联想词提交后可撤回，直到全员提交
- 公示结果后所有人点「确认，开始下一轮」才进入下一轮；有人离开会自动跳过他的确认

## 文件说明

| 文件 | 作用 |
| --- | --- |
| server.js | 游戏服务器（房间、倒计时、判定相遇、积分） |
| public/index.html | 手机端网页界面（全部前端代码） |
| package.json | 依赖清单 |
