const NETWORK_SETUP = "/usr/sbin/networksetup";
const ROUTE = "/sbin/route";
const NETSTAT = "/usr/sbin/netstat";
const PORT = Number(Bun.env.PORT ?? 4327);
const STATE_FILE = new URL("./.proxy-state.json", import.meta.url);
const ENFORCE_INTERVAL_MS = 5000;
const TRAFFIC_HISTORY_LIMIT = 60;

type ProxyStatus = {
  enabled: boolean;
  server: string;
  port: number | null;
};

type ServiceStatus = {
  service: string;
  http: ProxyStatus;
  https: ProxyStatus;
};

type ApiResponse<T> = {
  ok: boolean;
  data?: T;
  error?: string;
};

type DesiredProxyState = {
  enabled: boolean;
  service: string;
  host: string;
  port: string;
};

type InterfaceBytes = {
  name: string;
  receivedBytes: number;
  sentBytes: number;
};

type TrafficPoint = {
  time: number;
  receivedBytesPerSecond: number;
  sentBytesPerSecond: number;
};

let lastInterfaceBytes: (InterfaceBytes & { time: number }) | null = null;
let trafficHistory: TrafficPoint[] = [];

function json<T>(payload: ApiResponse<T>, status = 200) {
  return Response.json(payload, { status });
}

async function readDesiredState(): Promise<DesiredProxyState | null> {
  const file = Bun.file(STATE_FILE);
  if (!(await file.exists())) return null;

  try {
    const state = await file.json();
    if (
      typeof state.enabled === "boolean" &&
      typeof state.service === "string" &&
      typeof state.host === "string" &&
      typeof state.port === "string"
    ) {
      return state;
    }
  } catch {
    return null;
  }

  return null;
}

async function writeDesiredState(state: DesiredProxyState) {
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
}

async function runNetworkSetup(args: string[]) {
  return runCommand(NETWORK_SETUP, args);
}

async function runCommand(command: string, args: string[]) {
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe"
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);

  if (exitCode !== 0) {
    throw new Error((stderr || stdout || `networksetup exited with ${exitCode}`).trim());
  }

  return stdout.trim();
}

function cleanServiceName(line: string) {
  return line.replace(/^\*\s*/, "").trim();
}

function isVisibleService(service: string) {
  return /^wi-?fi$/i.test(service);
}

async function listServices() {
  const output = await runNetworkSetup(["-listallnetworkservices"]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("An asterisk"))
    .map(cleanServiceName)
    .filter(isVisibleService);
}

function parseProxy(output: string): ProxyStatus {
  const lines = output.split("\n");
  const value = (label: string) => {
    const line = lines.find((item) => item.toLowerCase().startsWith(label.toLowerCase()));
    return line?.split(":").slice(1).join(":").trim() ?? "";
  };

  const enabled = value("Enabled").toLowerCase() === "yes";
  const server = value("Server");
  const portText = value("Port");
  const port = portText ? Number(portText) : null;

  return {
    enabled,
    server,
    port: Number.isFinite(port) ? port : null
  };
}

async function serviceStatus(service: string): Promise<ServiceStatus> {
  const [http, https] = await Promise.all([
    runNetworkSetup(["-getwebproxy", service]).then(parseProxy),
    runNetworkSetup(["-getsecurewebproxy", service]).then(parseProxy)
  ]);

  return { service, http, https };
}

async function defaultInterface() {
  const output = await runCommand(ROUTE, ["-n", "get", "default"]);
  const line = output.split("\n").find((item) => item.trim().startsWith("interface:"));
  return line?.split(":").slice(1).join(":").trim() || "en0";
}

async function readInterfaceBytes(name: string): Promise<InterfaceBytes> {
  const output = await runCommand(NETSTAT, ["-ibn"]);
  const line = output
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name} `) && item.includes("<Link#"));

  if (!line) {
    throw new Error(`没有找到网卡 ${name} 的流量数据`);
  }

  const parts = line.split(/\s+/);
  const receivedBytes = Number(parts[6]);
  const sentBytes = Number(parts[9]);

  if (!Number.isFinite(receivedBytes) || !Number.isFinite(sentBytes)) {
    throw new Error(`网卡 ${name} 的流量数据解析失败`);
  }

  return { name, receivedBytes, sentBytes };
}

async function sampleTraffic() {
  const name = await defaultInterface();
  const current = await readInterfaceBytes(name);
  const now = Date.now();

  if (lastInterfaceBytes && lastInterfaceBytes.name === current.name) {
    const seconds = Math.max((now - lastInterfaceBytes.time) / 1000, 1);
    const receivedDelta = Math.max(current.receivedBytes - lastInterfaceBytes.receivedBytes, 0);
    const sentDelta = Math.max(current.sentBytes - lastInterfaceBytes.sentBytes, 0);

    trafficHistory.push({
      time: now,
      receivedBytesPerSecond: Math.round(receivedDelta / seconds),
      sentBytesPerSecond: Math.round(sentDelta / seconds)
    });

    if (trafficHistory.length > TRAFFIC_HISTORY_LIMIT) {
      trafficHistory = trafficHistory.slice(-TRAFFIC_HISTORY_LIMIT);
    }
  }

  lastInterfaceBytes = { ...current, time: now };

  return {
    interface: current.name,
    receivedBytes: current.receivedBytes,
    sentBytes: current.sentBytes,
    history: trafficHistory
  };
}

async function currentTraffic() {
  if (!lastInterfaceBytes) {
    return await sampleTraffic();
  }

  return {
    interface: lastInterfaceBytes.name,
    receivedBytes: lastInterfaceBytes.receivedBytes,
    sentBytes: lastInterfaceBytes.sentBytes,
    history: trafficHistory
  };
}

function proxyMatches(status: ServiceStatus, host: string, port: string) {
  return (
    status.http.enabled &&
    status.https.enabled &&
    status.http.server === host &&
    status.https.server === host &&
    String(status.http.port) === port &&
    String(status.https.port) === port
  );
}

async function enableSystemProxy(service: string, host: string, port: string) {
  await runNetworkSetup(["-setwebproxy", service, host, port]);
  await runNetworkSetup(["-setsecurewebproxy", service, host, port]);
  await runNetworkSetup(["-setwebproxystate", service, "on"]);
  await runNetworkSetup(["-setsecurewebproxystate", service, "on"]);
}

async function disableSystemProxy(service: string) {
  await runNetworkSetup(["-setwebproxystate", service, "off"]);
  await runNetworkSetup(["-setsecurewebproxystate", service, "off"]);
}

async function enforceDesiredProxy() {
  const desired = await readDesiredState();
  if (!desired?.enabled) return;

  const services = await listServices();
  if (!services.includes(desired.service)) return;

  const status = await serviceStatus(desired.service);
  if (!proxyMatches(status, desired.host, desired.port)) {
    await enableSystemProxy(desired.service, desired.host, desired.port);
  }
}

setInterval(() => {
  enforceDesiredProxy().catch((error) => {
    console.error("系统代理自动恢复失败:", error instanceof Error ? error.message : error);
  });
}, ENFORCE_INTERVAL_MS);

enforceDesiredProxy().catch(() => {});

setInterval(() => {
  sampleTraffic().catch((error) => {
    console.error("流量采样失败:", error instanceof Error ? error.message : error);
  });
}, 1000);

sampleTraffic().catch(() => {});

function validateService(service: unknown, services: string[]) {
  if (typeof service !== "string" || !service.trim()) {
    throw new Error("请选择网络服务");
  }
  if (!services.includes(service)) {
    throw new Error("网络服务不存在");
  }
  return service;
}

function validateHost(host: unknown) {
  if (typeof host !== "string") {
    throw new Error("代理地址不合法");
  }
  const value = host.trim();
  if (!/^[a-zA-Z0-9.-]+$/.test(value) || value.length > 253) {
    throw new Error("代理地址只能包含字母、数字、点和横线");
  }
  return value;
}

function validatePort(port: unknown) {
  const value = typeof port === "number" ? port : Number(String(port ?? ""));
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("端口必须是 1-65535 的整数");
  }
  return String(value);
}

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new Error("请求 JSON 不合法");
  }
}

async function handleApi(request: Request, pathname: string) {
  if (request.method === "GET" && pathname === "/api/services") {
    const services = await listServices();
    const preferred = services.find((item) => item.toLowerCase() === "wi-fi") ?? services[0] ?? "";
    const status = preferred ? await serviceStatus(preferred) : null;
    const desired = await readDesiredState();
    return json({ ok: true, data: { services, preferred, status, desired } });
  }

  if (request.method === "GET" && pathname === "/api/status") {
    const url = new URL(request.url);
    const services = await listServices();
    const service = validateService(url.searchParams.get("service"), services);
    const status = await serviceStatus(service);
    const desired = await readDesiredState();
    return json({ ok: true, data: { status, desired } });
  }

  if (request.method === "GET" && pathname === "/api/traffic") {
    return json({ ok: true, data: await currentTraffic() });
  }

  if (request.method === "POST" && pathname === "/api/proxy") {
    const body = await readJson(request);
    const services = await listServices();
    const service = validateService(body.service, services);
    const host = validateHost(body.host);
    const port = validatePort(body.port);

    await enableSystemProxy(service, host, port);
    await writeDesiredState({ enabled: true, service, host, port });

    return json({ ok: true, data: await serviceStatus(service) });
  }

  if (request.method === "POST" && pathname === "/api/proxy/off") {
    const body = await readJson(request);
    const services = await listServices();
    const service = validateService(body.service, services);

    await disableSystemProxy(service);
    const current = await readDesiredState();
    await writeDesiredState({
      enabled: false,
      service,
      host: current?.host ?? "",
      port: current?.port ?? ""
    });

    return json({ ok: true, data: await serviceStatus(service) });
  }

  return json({ ok: false, error: "API 不存在" }, 404);
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, url.pathname);
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(INDEX_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      return json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        },
        400
      );
    }
  }
});

console.log(`系统代理控制台已启动: http://localhost:${server.port}`);

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>系统代理控制台</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f8fa;
        --panel: #ffffff;
        --text: #17202a;
        --muted: #667085;
        --line: #d9dee7;
        --blue: #2563eb;
        --green: #138a52;
        --red: #c83d3d;
        --shadow: 0 10px 24px rgba(28, 39, 49, 0.08);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
        color: var(--text);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        letter-spacing: 0;
      }

      main {
        width: min(880px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0;
      }

      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 20px;
      }

      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.2;
        font-weight: 760;
      }

      .status-pill {
        min-width: 96px;
        border: 1px solid var(--line);
        background: var(--panel);
        border-radius: 999px;
        padding: 8px 12px;
        text-align: center;
        color: var(--muted);
        font-size: 13px;
        font-weight: 680;
      }

      .status-pill.on {
        border-color: rgba(19, 138, 82, 0.24);
        color: var(--green);
        background: #eefaf3;
      }

      .status-pill.off {
        border-color: rgba(200, 61, 61, 0.22);
        color: var(--red);
        background: #fff2f2;
      }

      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        box-shadow: var(--shadow);
        padding: 20px;
      }

      .grid {
        display: grid;
        grid-template-columns: 1.2fr 1fr 160px;
        gap: 14px;
        align-items: end;
      }

      label {
        display: grid;
        gap: 7px;
        color: var(--muted);
        font-size: 13px;
        font-weight: 680;
      }

      input,
      select {
        width: 100%;
        min-height: 42px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: #fff;
        color: var(--text);
        padding: 0 12px;
        font: inherit;
        outline: none;
      }

      input:focus,
      select:focus {
        border-color: var(--blue);
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.13);
      }

      .actions {
        display: flex;
        gap: 10px;
        margin-top: 18px;
        flex-wrap: wrap;
      }

      button {
        min-height: 40px;
        border: 1px solid transparent;
        border-radius: 6px;
        padding: 0 14px;
        font: inherit;
        font-size: 14px;
        font-weight: 720;
        cursor: pointer;
      }

      button.primary {
        background: var(--blue);
        color: #fff;
      }

      button.secondary {
        background: #fff;
        color: var(--text);
        border-color: var(--line);
      }

      button.danger {
        background: #fff;
        color: var(--red);
        border-color: rgba(200, 61, 61, 0.32);
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.62;
      }

      .details {
        margin-top: 18px;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }

      .item {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 14px;
        background: #fbfcfe;
      }

      .item-title {
        color: var(--muted);
        font-size: 12px;
        font-weight: 760;
        text-transform: uppercase;
        margin-bottom: 8px;
      }

      .item-value {
        font-size: 15px;
        font-weight: 720;
        overflow-wrap: anywhere;
      }

      .message {
        min-height: 22px;
        margin-top: 14px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.5;
      }

      .message.error {
        color: var(--red);
      }

      .message.ok {
        color: var(--green);
      }

      .traffic {
        margin-top: 18px;
        border-top: 1px solid var(--line);
        padding-top: 18px;
      }

      .traffic-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        margin-bottom: 12px;
      }

      .traffic-title {
        font-size: 15px;
        font-weight: 760;
      }

      .traffic-meta {
        color: var(--muted);
        font-size: 13px;
      }

      .traffic-chart {
        width: 100%;
        height: 220px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fbfcfe;
        display: block;
        cursor: crosshair;
      }

      .traffic-legend {
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
        margin-top: 10px;
        color: var(--muted);
        font-size: 13px;
      }

      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .legend-dot {
        width: 10px;
        height: 10px;
        border-radius: 999px;
      }

      .legend-dot.down {
        background: var(--blue);
      }

      .legend-dot.up {
        background: var(--green);
      }

      @media (max-width: 760px) {
        main {
          width: min(100vw - 24px, 880px);
          padding-top: 20px;
        }

        header {
          align-items: flex-start;
          flex-direction: column;
        }

        .grid,
        .details {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>系统代理控制台</h1>
        <div id="statusPill" class="status-pill">读取中</div>
      </header>

      <section class="panel">
        <div class="grid">
          <label>
            网络服务
            <select id="service"></select>
          </label>
          <label>
            代理地址
            <input id="host" value="100.0.0.1" autocomplete="off" />
          </label>
          <label>
            端口
            <input id="port" value="7810" inputmode="numeric" autocomplete="off" />
          </label>
        </div>

        <div class="actions">
          <button id="enableBtn" class="primary">开启</button>
          <button id="disableBtn" class="danger">关闭</button>
          <button id="refreshBtn" class="secondary">刷新</button>
        </div>

        <div class="details">
          <div class="item">
            <div class="item-title">网页代理</div>
            <div id="httpValue" class="item-value">-</div>
          </div>
          <div class="item">
            <div class="item-title">安全网页代理</div>
            <div id="httpsValue" class="item-value">-</div>
          </div>
        </div>

        <div class="traffic">
          <div class="traffic-head">
            <div class="traffic-title">实时流量</div>
            <div id="trafficMeta" class="traffic-meta">读取中</div>
          </div>
          <canvas id="trafficChart" class="traffic-chart"></canvas>
          <div class="traffic-legend">
            <span class="legend-item"><span class="legend-dot down"></span>下载 <span id="downloadRate">0 B/s</span></span>
            <span class="legend-item"><span class="legend-dot up"></span>上传 <span id="uploadRate">0 B/s</span></span>
          </div>
        </div>

        <div id="message" class="message"></div>
      </section>
    </main>

    <script>
      const els = {
        service: document.querySelector("#service"),
        host: document.querySelector("#host"),
        port: document.querySelector("#port"),
        statusPill: document.querySelector("#statusPill"),
        httpValue: document.querySelector("#httpValue"),
        httpsValue: document.querySelector("#httpsValue"),
        trafficMeta: document.querySelector("#trafficMeta"),
        trafficChart: document.querySelector("#trafficChart"),
        downloadRate: document.querySelector("#downloadRate"),
        uploadRate: document.querySelector("#uploadRate"),
        message: document.querySelector("#message"),
        enableBtn: document.querySelector("#enableBtn"),
        disableBtn: document.querySelector("#disableBtn"),
        refreshBtn: document.querySelector("#refreshBtn")
      };

      let busy = false;
      let trafficHistory = [];
      let trafficHover = null;

      function setBusy(value) {
        busy = value;
        els.enableBtn.disabled = busy;
        els.disableBtn.disabled = busy;
        els.refreshBtn.disabled = busy;
        els.service.disabled = busy;
      }

      function setMessage(text, type = "") {
        els.message.textContent = text;
        els.message.className = "message " + type;
      }

      async function api(path, options) {
        const response = await fetch(path, options);
        const payload = await response.json();
        if (!payload.ok) throw new Error(payload.error || "请求失败");
        return payload.data;
      }

      function proxyText(item) {
        if (!item.enabled) return "关闭";
        return item.server && item.port ? item.server + ":" + item.port : "开启";
      }

      function formatRate(bytes) {
        const units = ["B/s", "KB/s", "MB/s", "GB/s"];
        let value = Math.max(Number(bytes) || 0, 0);
        let index = 0;
        while (value >= 1024 && index < units.length - 1) {
          value = value / 1024;
          index += 1;
        }
        return (index === 0 ? value.toFixed(0) : value.toFixed(1)) + " " + units[index];
      }

      function drawLine(ctx, points, maxValue, width, height, color, key) {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;

        points.forEach((point, index) => {
          const x = points.length <= 1 ? width : (index / (points.length - 1)) * width;
          const y = height - (Math.max(point[key], 0) / maxValue) * height;
          if (index === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        });

        ctx.stroke();
      }

      function formatClock(time) {
        return new Date(time).toLocaleTimeString("zh-CN", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        });
      }

      function pointPosition(index, pointsLength, chartWidth, chartHeight, maxValue, value) {
        const x = pointsLength <= 1 ? chartWidth : (index / (pointsLength - 1)) * chartWidth;
        const y = chartHeight - (Math.max(value, 0) / maxValue) * chartHeight;
        return { x, y };
      }

      function roundedRect(ctx, x, y, width, height, radius) {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
      }

      function drawTrafficChart(history) {
        const canvas = els.trafficChart;
        const ratio = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = Math.max(Math.floor(rect.width * ratio), 1);
        canvas.height = Math.max(Math.floor(rect.height * ratio), 1);

        const ctx = canvas.getContext("2d");
        ctx.scale(ratio, ratio);

        const width = rect.width;
        const height = rect.height;
        const padding = { top: 22, right: 18, bottom: 34, left: 66 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;
        const points = history.slice(-60);
        const maxValue = Math.max(
          1024,
          ...points.map((item) => item.receivedBytesPerSecond),
          ...points.map((item) => item.sentBytesPerSecond)
        );

        ctx.clearRect(0, 0, width, height);

        ctx.fillStyle = "#fbfcfe";
        ctx.fillRect(0, 0, width, height);

        ctx.strokeStyle = "#e6eaf0";
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i += 1) {
          const y = padding.top + (chartHeight / 4) * i;
          const value = maxValue - (maxValue / 4) * i;
          ctx.beginPath();
          ctx.moveTo(padding.left, y);
          ctx.lineTo(width - padding.right, y);
          ctx.stroke();
          ctx.fillStyle = "#667085";
          ctx.font = "11px system-ui";
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          ctx.fillText(formatRate(value), padding.left - 8, y);
        }

        ctx.strokeStyle = "#cfd6e2";
        ctx.beginPath();
        ctx.moveTo(padding.left, padding.top);
        ctx.lineTo(padding.left, height - padding.bottom);
        ctx.lineTo(width - padding.right, height - padding.bottom);
        ctx.stroke();

        if (!points.length) return;

        const xTickIndexes = [0, Math.floor((points.length - 1) / 2), points.length - 1].filter(
          (value, index, array) => array.indexOf(value) === index
        );
        ctx.fillStyle = "#667085";
        ctx.font = "11px system-ui";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        for (const index of xTickIndexes) {
          const x = padding.left + pointPosition(index, points.length, chartWidth, chartHeight, maxValue, 0).x;
          ctx.fillText(formatClock(points[index].time), x, height - padding.bottom + 8);
        }

        ctx.save();
        ctx.translate(padding.left, padding.top);
        drawLine(ctx, points, maxValue, chartWidth, chartHeight, "#2563eb", "receivedBytesPerSecond");
        drawLine(ctx, points, maxValue, chartWidth, chartHeight, "#138a52", "sentBytesPerSecond");
        ctx.restore();

        if (trafficHover) {
          const hoverX = Math.min(Math.max(trafficHover.x - padding.left, 0), chartWidth);
          const index = Math.round((hoverX / chartWidth) * (points.length - 1));
          const point = points[index];
          const x = padding.left + pointPosition(index, points.length, chartWidth, chartHeight, maxValue, 0).x;
          const down = pointPosition(index, points.length, chartWidth, chartHeight, maxValue, point.receivedBytesPerSecond);
          const up = pointPosition(index, points.length, chartWidth, chartHeight, maxValue, point.sentBytesPerSecond);

          ctx.strokeStyle = "rgba(23, 32, 42, 0.36)";
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(x, padding.top);
          ctx.lineTo(x, height - padding.bottom);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = "#2563eb";
          ctx.beginPath();
          ctx.arc(padding.left + down.x, padding.top + down.y, 4, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = "#138a52";
          ctx.beginPath();
          ctx.arc(padding.left + up.x, padding.top + up.y, 4, 0, Math.PI * 2);
          ctx.fill();

          const lines = [
            formatClock(point.time),
            "下载 " + formatRate(point.receivedBytesPerSecond),
            "上传 " + formatRate(point.sentBytesPerSecond)
          ];
          ctx.font = "12px system-ui";
          const boxWidth = Math.max(...lines.map((line) => ctx.measureText(line).width)) + 18;
          const boxHeight = 68;
          const boxX = Math.min(Math.max(x + 10, 8), width - boxWidth - 8);
          const boxY = Math.min(Math.max(padding.top + 8, 8), height - boxHeight - 8);

          ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
          ctx.strokeStyle = "#d9dee7";
          ctx.lineWidth = 1;
          roundedRect(ctx, boxX, boxY, boxWidth, boxHeight, 6);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = "#17202a";
          ctx.textAlign = "left";
          ctx.textBaseline = "top";
          lines.forEach((line, lineIndex) => {
            ctx.fillText(line, boxX + 9, boxY + 8 + lineIndex * 18);
          });
        }
      }

      async function refreshTraffic() {
        try {
          const data = await api("/api/traffic");
          const latest = data.history[data.history.length - 1] || {
            receivedBytesPerSecond: 0,
            sentBytesPerSecond: 0
          };
          els.trafficMeta.textContent = "网卡 " + data.interface;
          els.downloadRate.textContent = formatRate(latest.receivedBytesPerSecond);
          els.uploadRate.textContent = formatRate(latest.sentBytesPerSecond);
          trafficHistory = data.history;
          drawTrafficChart(trafficHistory);
        } catch (error) {
          els.trafficMeta.textContent = "流量读取失败";
        }
      }

      function renderStatus(status) {
        if (!status) return;
        const enabled = status.http.enabled && status.https.enabled;
        els.statusPill.textContent = enabled ? "已开启" : "已关闭";
        els.statusPill.className = "status-pill " + (enabled ? "on" : "off");
        els.httpValue.textContent = proxyText(status.http);
        els.httpsValue.textContent = proxyText(status.https);

        if (status.http.server) els.host.value = status.http.server;
        if (status.http.port) els.port.value = status.http.port;
      }

      function renderDesired(desired) {
        if (!desired?.enabled) return;
        if (desired.host) els.host.value = desired.host;
        if (desired.port) els.port.value = desired.port;
      }

      async function loadInitial() {
        setBusy(true);
        setMessage("");
        try {
          const data = await api("/api/services");
          els.service.innerHTML = "";
          for (const service of data.services) {
            const option = document.createElement("option");
            option.value = service;
            option.textContent = service;
            els.service.appendChild(option);
          }
          els.service.value = data.preferred;
          renderStatus(data.status);
          renderDesired(data.desired);
          setMessage(data.desired?.enabled ? "自动保持已开启" : "已刷新", "ok");
        } catch (error) {
          setMessage(error.message, "error");
        } finally {
          setBusy(false);
        }
      }

      async function refreshStatus() {
        if (!els.service.value) return;
        setBusy(true);
        setMessage("");
        try {
          const data = await api("/api/status?service=" + encodeURIComponent(els.service.value));
          renderStatus(data.status);
          renderDesired(data.desired);
          setMessage(data.desired?.enabled ? "自动保持已开启" : "已刷新", "ok");
        } catch (error) {
          setMessage(error.message, "error");
        } finally {
          setBusy(false);
        }
      }

      async function enableProxy() {
        setBusy(true);
        setMessage("");
        try {
          const status = await api("/api/proxy", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              service: els.service.value,
              host: els.host.value,
              port: els.port.value
            })
          });
          renderStatus(status);
          setMessage("已开启，切换 Wi-Fi 后会自动补回", "ok");
        } catch (error) {
          setMessage(error.message, "error");
        } finally {
          setBusy(false);
        }
      }

      async function disableProxy() {
        setBusy(true);
        setMessage("");
        try {
          const status = await api("/api/proxy/off", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ service: els.service.value })
          });
          renderStatus(status);
          setMessage("已关闭，自动保持已停止", "ok");
        } catch (error) {
          setMessage(error.message, "error");
        } finally {
          setBusy(false);
        }
      }

      els.service.addEventListener("change", refreshStatus);
      els.refreshBtn.addEventListener("click", refreshStatus);
      els.enableBtn.addEventListener("click", enableProxy);
      els.disableBtn.addEventListener("click", disableProxy);
      els.trafficChart.addEventListener("mousemove", (event) => {
        const rect = els.trafficChart.getBoundingClientRect();
        trafficHover = {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top
        };
        drawTrafficChart(trafficHistory);
      });
      els.trafficChart.addEventListener("mouseleave", () => {
        trafficHover = null;
        drawTrafficChart(trafficHistory);
      });

      loadInitial();
      refreshTraffic();
      setInterval(refreshTraffic, 1000);
    </script>
  </body>
</html>`;
