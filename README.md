# 系统代理控制台

本项目是一个本机 macOS 系统代理控制页面，用 Bun 启动 Web 服务，通过 `/usr/sbin/networksetup` 修改当前网络服务的 HTTP / HTTPS 代理。

默认使用场景：

```text
代理地址: 100.0.0.1
代理端口: 7810
```

对应手工命令等价于在 macOS 网络设置里配置：

```text
Web 代理 HTTP: 100.0.0.1:7810
安全 Web 代理 HTTPS: 100.0.0.1:7810
```

## 功能

- 读取 macOS 网络服务列表，例如 `Wi-Fi`。
- 查看当前 HTTP / HTTPS 系统代理状态。
- 自定义代理 IP 和端口。
- 一键开启 HTTP / HTTPS 系统代理。
- 一键关闭 HTTP / HTTPS 系统代理。
- 开启后保存目标配置，服务运行期间每 5 秒检查一次 `Wi-Fi` 代理状态；如果切换 Wi-Fi 后系统代理被重置，会自动补回。

## 环境要求

```bash
bun --version
```

含义：确认本机已安装 Bun。

```bash
/usr/sbin/networksetup -listallnetworkservices
```

含义：确认当前用户可以读取 macOS 网络服务列表。

## 本地启动

进入项目目录：

```bash
cd /Users/dt-dn-083/code/duitang/system-proxy-control
```

启动服务：

```bash
PORT=4331 bun server.ts
```

含义：在本机 `4331` 端口启动 Web 控制台。

打开页面：

```text
http://localhost:4331
```

开发模式：

```bash
PORT=4331 bun --hot server.ts
```

含义：文件变化后自动热更新服务。

## 页面使用

1. 打开 `http://localhost:4331`。
2. 选择网络服务，通常是 `Wi-Fi`。
3. 填写代理地址，例如 `100.0.0.1`。
4. 填写代理端口，例如 `7810`。
5. 点击 `开启`。
6. 浏览器访问页面，确认已经走系统代理。
7. 保持本服务运行；切换 Wi-Fi 后服务会自动检查并恢复 `Wi-Fi` 的系统代理。

关闭代理时点击 `关闭`。

## 验证

查看 API 是否正常：

```bash
curl http://localhost:4331/api/services
```

含义：确认服务能读取 macOS 网络服务和当前代理状态。

查看系统代理：

```bash
/usr/sbin/networksetup -getwebproxy Wi-Fi
/usr/sbin/networksetup -getsecurewebproxy Wi-Fi
```

含义：确认 `Wi-Fi` 的 HTTP / HTTPS 代理是否已开启。

测试代理出口：

```bash
curl -4 https://ifconfig.me
```

含义：如果浏览器和系统命令走的是同一个代理出口，应返回代理服务器公网 IP。

## 部署为后台服务

如果希望切换 Wi-Fi 后也能自动恢复代理，需要把本服务作为后台服务常驻运行。

创建 launchd 配置：

```bash
mkdir -p ~/Library/LaunchAgents
vi ~/Library/LaunchAgents/com.local.system-proxy-control.plist
```

写入：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.local.system-proxy-control</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bun</string>
    <string>server.ts</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/dt-dn-083/code/duitang/system-proxy-control</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>4331</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/tmp/system-proxy-control.out.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/system-proxy-control.err.log</string>
</dict>
</plist>
```

加载服务：

```bash
launchctl load ~/Library/LaunchAgents/com.local.system-proxy-control.plist
```

含义：注册并启动后台服务。

查看服务：

```bash
launchctl list | grep system-proxy-control
```

含义：确认 launchd 已加载该服务。

停止服务：

```bash
launchctl unload ~/Library/LaunchAgents/com.local.system-proxy-control.plist
```

含义：停止并卸载后台服务。

查看日志：

```bash
tail -f /tmp/system-proxy-control.out.log
tail -f /tmp/system-proxy-control.err.log
```

含义：查看服务启动和错误日志。

## 注意事项

- 本工具只适用于 macOS。
- 本工具只控制系统 HTTP / HTTPS 代理，不控制 SOCKS 代理。
- `networksetup` 可能触发 macOS 权限校验；如果页面提示授权失败，请在终端直接运行启动命令。
- 如果浏览器安装了代理插件，插件规则可能覆盖系统代理。
- 如果当前网络服务不是 `Wi-Fi`，需要在页面选择实际正在使用的服务。

## 手工回滚

关闭 `Wi-Fi` 的 HTTP / HTTPS 系统代理：

```bash
/usr/sbin/networksetup -setwebproxystate Wi-Fi off
/usr/sbin/networksetup -setsecurewebproxystate Wi-Fi off
```

含义：不通过页面，直接关闭系统代理。
