Page({
  data: { result: 'pending' },
  onLoad: function () {
    var self = this
    wx.getFileSystemManager().readFile({
      filePath: wx.env.USER_DATA_PATH + '/journey/saved.txt',
      encoding: 'utf8',
      success: function () { self.setData({ result: 'visible' }) },
      fail: function () { self.setData({ result: 'missing' }) },
    })
  },
})
