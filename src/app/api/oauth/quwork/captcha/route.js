import { QUWORK_CAPTCHA } from "open-sse/shared/quwork/client.js";

export const dynamic = "force-dynamic";

// GET /api/oauth/quwork/captcha — 阿里云滑块人机验证页（QuWork 短信登录前置）。
// 由 QuWork 登录弹窗 window.open 打开；验证成功后把 captchaVerifyParam 经
// postMessage 交回同源 opener 并自动关闭。没有 opener 时（被拦截/新标签）
// 显示 token 供手动复制粘贴回弹窗。SDK 优先用本地副本（取自 quwork-auth
// 包，MIT），失败回落阿里云官方 CDN。配置与 QuWork 桌面端一致：
// region=cn prefix=1hms8d SceneId=10vzkucv。
const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QuWork 人机验证</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; background:#f5f6fa; color:#1f2329; }
  .card { width:min(420px,92vw); padding:24px; background:#fff; border-radius:16px; box-shadow:0 8px 40px rgba(0,0,0,.08); text-align:center; }
  h2 { margin:0 0 12px; font-size:18px; }
  #status { min-height:24px; font-size:14px; color:#555; margin-bottom:8px; }
  #captcha-element { min-height:40px; margin:0 auto; }
  button { margin-top:10px; padding:8px 18px; border:0; border-radius:8px; background:#ff7a06; color:#fff; font-size:14px; cursor:pointer; }
  #captcha-button { display:none; }
  textarea { width:100%; height:90px; margin-top:10px; font-size:11px; display:none; }
</style>
</head>
<body>
<div class="card">
  <h2>QuWork 登录人机验证</h2>
  <div id="status">正在加载验证码组件…</div>
  <div id="captcha-element"></div>
  <button id="captcha-button" type="button">验证</button>
  <button id="retry" type="button" onclick="trigger()">开始 / 重新验证</button>
  <textarea id="token" readonly></textarea>
</div>
<script>
window.AliyunCaptchaConfig = { region: '${QUWORK_CAPTCHA.region}', prefix: '${QUWORK_CAPTCHA.prefix}' };
var ready = false;
function setStatus(t) { document.getElementById('status').textContent = t; }
function trigger() {
  if (!ready) { setStatus('组件尚未就绪，请稍等…'); return; }
  setStatus('请在弹出的窗口中完成滑动验证');
  document.getElementById('captcha-button').click();
}
function deliver(token) {
  var sent = false;
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'quwork-captcha', token: token }, window.location.origin);
      sent = true;
    }
  } catch (e) {}
  if (sent) {
    setStatus('验证成功！正在返回登录窗口发送短信验证码…');
    setTimeout(function () { window.close(); }, 800);
  } else {
    setStatus('验证成功！请复制下面的验证结果，粘贴回 QuWork 登录窗口');
    var ta = document.getElementById('token'); ta.style.display = 'block'; ta.value = token; ta.select();
  }
}
function initCaptcha() {
  if (typeof window.initAliyunCaptcha !== 'function') { setTimeout(initCaptcha, 200); return; }
  window.initAliyunCaptcha({
    SceneId: '${QUWORK_CAPTCHA.sceneId}',
    region: '${QUWORK_CAPTCHA.region}',
    prefix: '${QUWORK_CAPTCHA.prefix}',
    mode: 'popup',
    element: '#captcha-element',
    button: '#captcha-button',
    language: 'cn',
    success: function (param) { deliver(typeof param === 'string' ? param : JSON.stringify(param)); },
    fail: function () { setStatus('验证未通过，点击“开始 / 重新验证”再试一次'); },
    onError: function (e) { setStatus('组件报错：' + ((e && (e.msg || e.message)) || '未知错误')); },
    getInstance: function () { ready = true; setStatus('组件就绪，正在弹出滑块…'); setTimeout(trigger, 400); }
  });
}
function loadSdk(src, onFail) {
  var s = document.createElement('script'); s.src = src; s.onload = initCaptcha; s.onerror = onFail; document.head.appendChild(s);
}
loadSdk('/quwork/aliyun-captcha-sdk.js', function () {
  loadSdk('https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js', function () { setStatus('验证码组件加载失败，请检查网络'); });
});
</script>
</body>
</html>`;

export async function GET() {
  return new Response(HTML, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
    },
  });
}
