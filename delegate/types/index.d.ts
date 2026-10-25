export type Draft = {
  pName: string
  pUrl: string
  pKey: string
  keyFor: string
  keyValue: string
  flashProvider: string
  flashModel: string
  proProvider: string
  proModel: string
  flashEffort: string
  proEffort: string
}

declare module 'claude-code' {
  interface PluginState {
    delegate: { draft: Draft; flash: string; version: number; liveSel: string; liveMsg: string; liveNote: string; liveTick: number; liveMore: boolean; liveAll: boolean; livePage: number }
  }
}
