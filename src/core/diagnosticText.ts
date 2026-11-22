import { uiText } from '../i18n/messages'
// 日志只保留有限脱敏文本，避免暴露凭据和地址参数
export function redactDiagnosticText(value: string, limit = Infinity): string {
  const maximum = 4096
  return value.slice(0, maximum * 2)
    .replace(/\b(?:bearer|basic)\s+[^\s,;"'<>]+/gi, uiText("collaboration.diagnostics.theEvidenceIsHidden"))
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi, uiText("core.diagnosticText.addressHidden"))
    .replace(/\bdata:[^\s<>"'`]+/gi, uiText("core.diagnosticText.dataAddressHidden"))
    .replace(/[?#][^\s<>"'`)]*/g, uiText("core.diagnosticText.parametersHidden"))
    .replace(/(["']?(?:authorization|proxy-authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|connectionKey|localControlKey|secret|password|passwd|cookie|set-cookie)["']?\s*[:=]\s*)(?:\(凭据已隐藏\)|"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;)}\]]+)/gi, uiText("core.diagnosticText.understandingHidden"))
    .replace(/\bmcrh_bylittle100_[A-Za-z]{64}\b/g, uiText("collaboration.diagnostics.theEvidenceIsHidden"))
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, uiText("collaboration.diagnostics.theEvidenceIsHidden"))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, uiText("collaboration.diagnostics.theEvidenceIsHidden"))
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .slice(0, Math.max(0, Math.min(limit, maximum)))
}
