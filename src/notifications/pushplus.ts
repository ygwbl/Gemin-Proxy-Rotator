import { rotatorEnv } from "../env.js";

// 用户配置的默认 Pushplus Token
const DEFAULT_PUSHPLUS_TOKEN = "6978c77025ff4b07935c486634ad3b30";

// 防抖缓存：key -> 触发毫秒时间戳（30 分钟内同账号同类告警不重复刷屏）
const alertDebounceMap = new Map<string, number>();
const DEBOUNCE_MS = 30 * 60 * 1000;

export function getPushplusToken(): string {
  return (
    rotatorEnv("PUSHPLUS_TOKEN") ||
    process.env.PUSHPLUS_TOKEN ||
    DEFAULT_PUSHPLUS_TOKEN
  ).trim();
}

/**
 * 发送 Pushplus 微信消息
 */
export async function sendPushplus(
  title: string,
  contentHtml: string,
): Promise<{ ok: boolean; msg?: string }> {
  const token = getPushplusToken();
  if (!token) return { ok: false, msg: "未配置 Pushplus Token" };

  try {
    const payload = {
      token,
      title,
      content: contentHtml,
      template: "html",
    };

    const res = await fetch("http://www.pushplus.plus/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = (await res.json()) as any;
    if (data && (data.code === 200 || data.code === 0)) {
      return { ok: true, msg: data.msg || "发送成功" };
    }
    return { ok: false, msg: data.msg || `Pushplus 错误码: ${data?.code}` };
  } catch (err: any) {
    return { ok: false, msg: err.message };
  }
}

/**
 * 额度低位预警通知（当账号 5h 或 7d 周期配额 <= 10% 时触发）
 */
export async function notifyQuotaWarning(
  email: string,
  quotaKey: string,
  percentRemaining: number,
  resetTime?: string,
): Promise<void> {
  const debounceKey = `quota_${email}_${quotaKey}`;
  const lastTime = alertDebounceMap.get(debounceKey) || 0;
  if (Date.now() - lastTime < DEBOUNCE_MS) return;
  alertDebounceMap.set(debounceKey, Date.now());

  const resetDesc = resetTime
    ? new Date(resetTime).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
    : "计算中...";

  const content = `
    <div style="font-family: sans-serif; padding: 12px; border: 1px solid #f87171; border-radius: 8px; background: #fef2f2;">
      <h3 style="color: #dc2626; margin-top: 0;">⚠️ 账号配额告急预警</h3>
      <p><b>监控账号：</b><code style="background:#fee2e2;padding:2px 5px;border-radius:4px;">${email}</code></p>
      <p><b>告警池位：</b>${quotaKey.includes("weekly") ? "📅 7天周配额池" : "⚡ 5小时滚动核心水位"}</p>
      <p><b>剩余配额：</b><span style="color:#dc2626;font-size:16px;font-weight:bold;">${percentRemaining}%</span> (已跌破 10% 预警线)</p>
      <p><b>预计重置：</b>${resetDesc}</p>
      <hr style="border: none; border-top: 1px dashed #fca5a5; margin: 12px 0;" />
      <p style="font-size: 12px; color: #6b7280; margin-bottom: 0;">
        🤖 反重力转子系统已自动将后续高优先级请求引流至健康备用账号，保证编程无感中断。
      </p>
    </div>
  `;

  await sendPushplus(`⚠️ 反重力额度告急: ${email} (${percentRemaining}%)`, content);
}

/**
 * 账号智能平滑切换提醒
 */
export async function notifyAccountRotation(
  fromEmail: string,
  toEmail: string,
  reason: string,
): Promise<void> {
  const debounceKey = `rotation_${fromEmail}_${toEmail}`;
  const lastTime = alertDebounceMap.get(debounceKey) || 0;
  if (Date.now() - lastTime < DEBOUNCE_MS) return;
  alertDebounceMap.set(debounceKey, Date.now());

  const content = `
    <div style="font-family: sans-serif; padding: 12px; border: 1px solid #60a5fa; border-radius: 8px; background: #eff6ff;">
      <h3 style="color: #2563eb; margin-top: 0;">🔄 智能多号无感切换通知</h3>
      <p><b>原主力账号：</b><code>${fromEmail}</code></p>
      <p><b>新接管账号：</b><code style="background:#dbeafe;padding:2px 5px;border-radius:4px;font-weight:bold;">${toEmail}</code></p>
      <p><b>切换原因：</b>${reason}</p>
      <p><b>切换时间：</b>${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</p>
      <hr style="border: none; border-top: 1px dashed #bfdbfe; margin: 12px 0;" />
      <p style="font-size: 12px; color: #6b7280; margin-bottom: 0;">
        💡 新接管账号具备完全独立的虚拟硬件指纹与专属环境，已无缝承接后续全部请求。
      </p>
    </div>
  `;

  await sendPushplus(`🔄 反重力智能切号: 已平滑切换至 ${toEmail}`, content);
}

/**
 * 熔断冷却 / 官方限流告警
 */
export async function notifyCircuitBreaker(
  email: string,
  reason: string,
): Promise<void> {
  const debounceKey = `breaker_${email}`;
  const lastTime = alertDebounceMap.get(debounceKey) || 0;
  if (Date.now() - lastTime < DEBOUNCE_MS) return;
  alertDebounceMap.set(debounceKey, Date.now());

  const content = `
    <div style="font-family: sans-serif; padding: 12px; border: 1px solid #f59e0b; border-radius: 8px; background: #fffbeb;">
      <h3 style="color: #d97706; margin-top: 0;">🛡️ 触发防封保护熔断</h3>
      <p><b>受保护账号：</b><code>${email}</code></p>
      <p><b>熔断原因：</b>${reason}</p>
      <p><b>保护策略：</b>系统已暂停向该账号派发高频请求，进入 6 小时保护性冷却以防风控扩大化，备用账号已自动接管。</p>
      <p><b>触发时间：</b>${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</p>
    </div>
  `;

  await sendPushplus(`🛡️ 反重力防封熔断保护: ${email}`, content);
}
