// app.js
App({
  globalData: {
    // BLE 协议常量（和 ESP32 端 bluetooth_manager.h 保持一致）
    // 16-bit UUID 0xXXXX 的 128-bit 展开格式为 0000XXXX-0000-1000-8000-00805F9B34FB
    SERVICE_UUID: '000000FF-0000-1000-8000-00805F9B34FB',  // 0x00FF
    WRITE_UUID:   '0000FF01-0000-1000-8000-00805F9B34FB',  // 0xFF01
    NOTIFY_UUID:  '0000FF02-0000-1000-8000-00805F9B34FB',  // 0xFF02
    DEVICE_NAME_PREFIX: 'xingya_',
    // 运行时状态
    deviceId: '',
    connected: false,
    // 隐私协议状态：true=已同意，false=未同意
    privacyAgreed: false,
    // 隐私弹窗回调（页面设置，同意后触发）
    _privacyResolve: null
  },

  onLaunch() {
    console.log('[App] onLaunch');
    // 检查隐私协议状态
    this._checkPrivacy();
  },

  onHide() {
    console.log('[App] onHide');
  },

  // 检查是否需要弹出隐私协议
  _checkPrivacy() {
    if (typeof wx.getPrivacySetting !== 'function') {
      // 基础库不支持，视为已同意
      this.globalData.privacyAgreed = true;
      return;
    }
    wx.getPrivacySetting({
      success: (res) => {
        if (res.needAuthorization) {
          // 需要用户同意隐私协议
          console.log('[App] 需要隐私授权');
          this.globalData.privacyAgreed = false;
        } else {
          console.log('[App] 隐私已授权');
          this.globalData.privacyAgreed = true;
        }
      },
      fail: () => {
        // 接口调用失败，视为已同意（兼容处理）
        this.globalData.privacyAgreed = true;
      }
    });

    // 注册隐私授权拦截：任何隐私 API 调用前会触发
    if (typeof wx.onNeedPrivacyAuthorization === 'function') {
      wx.onNeedPrivacyAuthorization((resolve) => {
        console.log('[App] onNeedPrivacyAuthorization 触发，等待用户同意');
        // 保存 resolve，用户同意后调用
        this.globalData._privacyResolve = resolve;
        // 通知当前页面弹出隐私弹窗
        if (this._onNeedPrivacy) this._onNeedPrivacy();
      });
    }
  },

  // 用户同意隐私协议后调用
  agreePrivacy() {
    this.globalData.privacyAgreed = true;
    if (this.globalData._privacyResolve) {
      this.globalData._privacyResolve();
      this.globalData._privacyResolve = null;
    }
  }
});
