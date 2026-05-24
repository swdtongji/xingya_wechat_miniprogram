// components/privacy-popup/privacy-popup.js
Component({
  properties: {
    show: {
      type: Boolean,
      value: false
    }
  },

  methods: {
    // 用户同意隐私协议
    onAgree() {
      this.setData({ show: false });
      this.triggerEvent('agree');
    },

    // 查看完整隐私协议（可跳转到协议页面，这里仅提示）
    onViewPolicy() {
      wx.showModal({
        title: '隐私保护指引',
        content: '本小程序仅使用蓝牙和定位权限用于扫描附近 BLE 设备，不会收集、存储或上传任何个人信息。',
        showCancel: false,
        confirmText: '知道了'
      });
    },

    // 阻止冒泡
    stopPropagation() {}
  }
});
