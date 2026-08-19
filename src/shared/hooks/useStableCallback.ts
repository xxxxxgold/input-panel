import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * 返回身份稳定且始终调用最新实现的回调，适用于事件处理器和跨渲染延迟任务。
 */
export function useStableCallback<TArgs extends unknown[], TResult>(
  callback: (...args: TArgs) => TResult
): (...args: TArgs) => TResult {
  const callbackRef = useRef(callback);

  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  return useCallback((...args: TArgs) => callbackRef.current(...args), []);
}
