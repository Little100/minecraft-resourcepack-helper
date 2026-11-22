export interface PreviewSession {
  kind: 'texture' | 'syntax' | 'model' | 'gui'
  source: string
  following?: boolean
  selected?: string
  scene?: string
}

export function postPreviewSession(webview: { postMessage(value: unknown): Thenable<boolean> }, session: PreviewSession): void {
  void webview.postMessage({ command: 'mcrhPreviewSession', session })
}

// 页面自己的控件状态和宿主资源定位共享存储，避免相互覆盖
export function previewSessionBootstrap(page: string): string {
  if (!['preview', 'syntax', 'vanillaPreview', 'guiPreview'].includes(page)) return ''
  return `(() => {
    const acquire = window.acquireVsCodeApi;
    if (typeof acquire !== 'function') return;
    const api = acquire();
    const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    let session = record(api.getState?.()).mcrhPreview;
    const shared = Object.freeze({
      postMessage: (...args) => api.postMessage(...args),
      getState: () => api.getState?.(),
      setState: value => api.setState?.(session ? Object.assign({}, record(value), { mcrhPreview: session }) : value)
    });
    window.acquireVsCodeApi = () => shared;
    window.addEventListener('message', event => {
      if (event.data && event.data.command === 'mcrhPreviewSession') {
        session = event.data.session;
        shared.setState(api.getState?.());
      }
    });
  })();`
}
