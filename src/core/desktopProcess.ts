export function desktopLaunchEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !/^ELECTRON_RUN_AS_NODE$|^NODE_OPTIONS$|^VSCODE_(?!PORTABLE$)/i.test(key)))
}
