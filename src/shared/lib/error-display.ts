const URL_REQUEST_ERROR_PATTERN = /error sending request for url \(([^)]+)\)/i;
const REQUEST_STATUS_PATTERN = /Request failed:\s*(\d{3})/i;

export function formatAppErrorMessage(message: string | null | undefined) {
  const rawMessage = message?.trim();
  if (!rawMessage) {
    return "操作失败, 请稍后重试。";
  }

  const urlErrorMatch = rawMessage.match(URL_REQUEST_ERROR_PATTERN);
  if (urlErrorMatch) {
    return describeUrlRequestFailure(urlErrorMatch[1]);
  }

  if (rawMessage.includes("未找到可用的接口路径")) {
    return "当前站点暂不支持这个接口, 请稍后重试或切换账号。";
  }

  const requestStatus = rawMessage.match(REQUEST_STATUS_PATTERN)?.[1];
  if (requestStatus) {
    return describeRequestStatus(requestStatus, rawMessage);
  }

  return stripRawUrls(rawMessage) || "操作失败, 请稍后重试。";
}

function describeUrlRequestFailure(url: string) {
  const path = extractRequestPath(url);
  if (path.startsWith("/api/v1/usage")) {
    return "用量数据请求失败, 上游接口暂时不可用, 请稍后重试。";
  }
  if (path.startsWith("/api/v1/user/api-keys/")) {
    return "单 Key 用量请求失败, 请稍后重试。";
  }
  return "请求上游服务失败, 请稍后重试。";
}

function describeRequestStatus(status: string, rawMessage: string) {
  switch (status) {
    case "401":
      return "登录状态已失效, 请重新登录账号。";
    case "403":
      return "当前账号没有权限执行这个操作。";
    case "404":
      return rawMessage.includes("usage")
        ? "当前站点暂不支持用量接口, 请稍后重试或切换账号。"
        : "请求的资源不存在。";
    case "429":
      return "请求过于频繁, 请稍后再试。";
    default:
      return `请求失败, 服务器返回 ${status}。`;
  }
}

function extractRequestPath(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function stripRawUrls(message: string) {
  return message.replace(/https?:\/\/\S+/gi, "").replace(/\s{2,}/g, " ").trim();
}
