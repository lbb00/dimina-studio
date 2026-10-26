Page({
  data: { mapVisible: true },
  onToggleMap() {
    this.setData({ mapVisible: !this.data.mapVisible })
  },
})
