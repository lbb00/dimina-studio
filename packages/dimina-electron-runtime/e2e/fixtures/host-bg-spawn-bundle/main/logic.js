// Dedicated fixture for host-background-page-lifecycle.spec.ts's
// "spawned while already backgrounded" scenario. `syncAppVisibility` (see
// bridge-router-api-navigation.ts) can deliver its deferred appHide before
// any script has a chance to attach `wx.onAppHide` after the fact — the App
// instance's own onLaunch is the one place that is guaranteed to run BEFORE
// the container's `serviceResourceLoaded` message (which is what gates that
// delivery), so lifecycle recording is registered here at construction time,
// not injected from the test side.
modDefine('app', (require, module, exports) => {
  App({
    onLaunch() {
      globalThis.__lcSeq = []
      wx.onAppShow(() => { globalThis.__lcSeq.push('App.onShow') })
      wx.onAppHide(() => { globalThis.__lcSeq.push('App.onHide') })
    },
  })
})

modDefine('pages/index/index', (require, module, exports) => {
  globalThis.__extraInfo = {
    path: 'pages/index/index',
    component: false,
    usingComponents: {},
  }
  Page({
    data: { title: 'Home' },
    onShow() { globalThis.__lcSeq.push('Page.onShow') },
    onHide() { globalThis.__lcSeq.push('Page.onHide') },
  })
})
